import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { lstat, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { OrchError } from '../core/errors.ts'
import { resolveInside, type HostRunner } from './tools.ts'

// Microsoft BaseContainer's v0.1.0 SBOX schema. Missing or incompatible
// Windows APIs fail before the command can run.
function sandboxSpec(view: string, scratch: string): string {
  const version = Buffer.from('0.1.0')
  const strings = [Buffer.from(scratch), Buffer.from(view)]
  const data = Buffer.alloc(80 + strings.reduce((n, s) => n + Math.ceil((5 + s.length) / 4) * 4, 0))
  data.writeUInt32LE(32, 0)
  data.write('SBOX', 4)
  data.writeUInt16LE(22, 8)
  data.writeUInt16LE(20, 10)
  for (const [slot, offset] of [[0, 4], [1, 8], [7, 12], [8, 16]] as const) data.writeUInt16LE(offset, 12 + 2 * slot)
  data.writeInt32LE(24, 32)
  data.writeUInt32LE(32, 36) // version
  data[40] = 1 // AppContainer
  data.writeUInt32LE(8, 44) // fs_read_write
  data.writeUInt32LE(12, 48) // fs_read_only
  data.writeUInt32LE(version.length, 68)
  version.copy(data, 72)
  let cursor = 80
  for (const [index, value] of strings.entries()) {
    const vector = 52 + 8 * index
    data.writeUInt32LE(1, vector)
    data.writeUInt32LE(cursor - (vector + 4), vector + 4)
    data.writeUInt32LE(value.length, cursor)
    value.copy(data, cursor + 4)
    cursor += Math.ceil((5 + value.length) / 4) * 4
  }
  return data.toString('base64')
}

const launcher = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;

public static class OrchestraContainer {
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
    struct Startup {
        public uint Size;
        public string Reserved, Desktop, Title;
        public uint X, Y, XSize, YSize, XCountChars, YCountChars, FillAttribute, Flags;
        public ushort ShowWindow, Reserved2;
        public IntPtr Data, Stdin, Stdout, Stderr;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct Child {
        public IntPtr Process, Thread;
        public uint ProcessId, ThreadId;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct JobLimits {
        public long ProcessUserTime, JobUserTime;
        public uint Flags;
        public UIntPtr MinWorkingSet, MaxWorkingSet;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint Priority, Scheduling;
        public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct FileInformation {
        public uint Attributes, CreatedLow, CreatedHigh, AccessedLow, AccessedHigh, WrittenLow, WrittenHigh;
        public uint Serial, SizeHigh, SizeLow, LinkCount, IndexHigh, IndexLow;
    }
    [DllImport("processmodel.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)]
    static extern bool Experimental_CreateProcessInSandbox(string application, StringBuilder command,
        IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment,
        string cwd, ref Startup info, string identity, byte[] spec, uint specSize, out Child process);
    [DllImport("userenv.dll", CharSet=CharSet.Unicode, ExactSpelling=true)]
    static extern int DeleteAppContainerProfile(string identity);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref JobLimits limits, int size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint ms);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint status);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint status);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle h, out FileInformation info);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetTokenInformation(IntPtr token, int kind, out int value, int length, out int needed);
    static Win32Exception Error(string stage) { return new Win32Exception(Marshal.GetLastWin32Error(), stage); }

    static void CheckView(string path, SecurityIdentifier owner) {
        var attributes = File.GetAttributes(path);
        if ((attributes & FileAttributes.ReparsePoint) != 0)
            throw new UnauthorizedAccessException("Reparse point in the isolated workspace view");
        bool directory = (attributes & FileAttributes.Directory) != 0;
        var security = directory
            ? (FileSystemSecurity)Directory.GetAccessControl(path, AccessControlSections.Owner)
            : File.GetAccessControl(path, AccessControlSections.Owner);
        var actual = security.GetOwner(typeof(SecurityIdentifier));
        if (!owner.Equals(actual)) throw new UnauthorizedAccessException("Unexpected workspace view owner");
        if (directory) {
            foreach (string entry in Directory.EnumerateFileSystemEntries(path)) CheckView(entry, owner);
        } else {
            using (var file = File.OpenRead(path)) {
                FileInformation info;
                if (!GetFileInformationByHandle(file.SafeFileHandle, out info)) throw Error("GetFileInformationByHandle");
                if (info.LinkCount != 1) throw new UnauthorizedAccessException("Hard link in the isolated workspace view");
            }
        }
    }

    public static void Run(string shell, string encoded, string base64, string identity, string view, string result, uint timeout) {
        var stopped = Task.Factory.StartNew(() => Console.In.Read(), TaskCreationOptions.LongRunning);
        CheckView(view, WindowsIdentity.GetCurrent().User);
        if (stopped.IsCompleted) throw new OperationCanceledException();
        var spec = Convert.FromBase64String(base64);
        var startup = new Startup { Size = (uint)Marshal.SizeOf(typeof(Startup)) };
        var job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw Error("CreateJobObject");
        Child child = new Child();
        try {
            // Pin the result file while the worker writes through a different handle.
            File.Create(result).Dispose();
            using (var file = new FileStream(result, FileMode.Open, FileAccess.Read, FileShare.ReadWrite)) {
            // Admit only the worker and its registered executable. Leaving no descendant
            // running after the executable exits protects the worker's captured receipt.
            var limits = new JobLimits {
                Flags = 0x2000 | 0x0200 | 0x0008,
                JobMemory = (UIntPtr)(512 * 1024 * 1024),
                ActiveProcessLimit = 2
            };
            if (!SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(typeof(JobLimits)))) throw Error("SetInformationJobObject");
            if (!Experimental_CreateProcessInSandbox(shell, new StringBuilder("\"" + shell + "\" -NoProfile -NonInteractive -EncodedCommand " + encoded),
                IntPtr.Zero, IntPtr.Zero, false, 0x08000004, IntPtr.Zero, Environment.SystemDirectory,
                ref startup, identity, spec, (uint)spec.Length, out child)) throw Error("CreateProcessInSandbox");
            if (!AssignProcessToJobObject(job, child.Process)) throw Error("AssignProcessToJobObject");
            IntPtr token;
            if (!OpenProcessToken(child.Process, 8, out token)) throw Error("OpenProcessToken");
            try {
                int appContainer, needed;
                if (!GetTokenInformation(token, 29, out appContainer, 4, out needed) || appContainer != 1)
                    throw new InvalidOperationException("The child token is not an AppContainer");
            } finally { CloseHandle(token); }
            if (stopped.IsCompleted) throw new OperationCanceledException();
            if (ResumeThread(child.Thread) == uint.MaxValue) throw Error("ResumeThread");
            var elapsed = Stopwatch.StartNew();
            while (true) {
                uint wait = WaitForSingleObject(child.Process, 100);
                if (wait == 0) break;
                if (wait != 258) throw Error("WaitForSingleObject");
                if (stopped.IsCompleted) throw new OperationCanceledException();
                if (elapsed.ElapsedMilliseconds >= timeout) throw new TimeoutException("The isolated process did not exit");
            }
            uint exit;
            if (!GetExitCodeProcess(child.Process, out exit) || exit != 0) throw new InvalidOperationException("The isolated runner did not finish");
            CloseHandle(job);
            job = IntPtr.Zero;
            if (file.Length > 1024 * 1024) throw new IOException("The isolated result is too large");
            using (var reader = new StreamReader(file, Encoding.UTF8)) Console.WriteLine(reader.ReadToEnd());
            }
        } finally {
            if (child.Process != IntPtr.Zero) {
                TerminateProcess(child.Process, 124);
                CloseHandle(child.Thread);
                CloseHandle(child.Process);
            }
            if (job != IntPtr.Zero) CloseHandle(job);
            DeleteAppContainerProfile(identity);
        }
    }
}
'@
[Console]::InputEncoding = New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$request = ConvertFrom-Json ([Console]::In.ReadLine())
[OrchestraContainer]::Run($request.shell, $request.encoded, $request.spec, $request.identity, $request.view, $request.result, $request.timeout)
`

const worker = String.raw`
$ErrorActionPreference = 'Stop'
$request = ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('PAYLOAD')))
$start = New-Object Diagnostics.ProcessStartInfo
$start.FileName = $request.bin
$start.Arguments = $request.argv
$start.WorkingDirectory = $request.cwd
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$start.RedirectStandardOutput = $true
$start.RedirectStandardError = $true
$start.RedirectStandardInput = $true
$start.EnvironmentVariables.Clear()
$start.EnvironmentVariables['SystemRoot'] = $env:SystemRoot
$start.EnvironmentVariables['TEMP'] = $request.scratch
$start.EnvironmentVariables['TMP'] = $request.scratch
$tool = [Diagnostics.Process]::Start($start)
try {
  $tool.StandardInput.Close()
  $stdout = $tool.StandardOutput.ReadToEndAsync()
  $stderr = $tool.StandardError.ReadToEndAsync()
  $tool.WaitForExit()
  $output = @{exitCode = $tool.ExitCode; stdout = $stdout.GetAwaiter().GetResult(); stderr = $stderr.GetAwaiter().GetResult()}
  $json = ConvertTo-Json -Compress $output
  [IO.File]::WriteAllText($request.result, $json, (New-Object Text.UTF8Encoding($false)))
} finally {
  $tool.Dispose()
}
`

function quoteArg(value: string): string {
  return '"' + value.replace(/(\\*)"/gu, '$1$1\\"').replace(/\\+$/u, '$&$&') + '"'
}

function encoded(script: string): string { return Buffer.from(script, 'utf16le').toString('base64') }

export type WindowsReadOnlyHost = HostRunner & { close(): Promise<void> }

/** The trusted provider populates a fresh view and registers the executables. */
export async function createWindowsReadOnlyHost(workspaceRoot: string, populate: (view: string) => Promise<void>): Promise<WindowsReadOnlyHost | undefined> {
  const windows = process.env.SystemRoot
  if (process.platform !== 'win32' || !windows || !isAbsolute(windows)) return
  const shell = join(windows, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const root = await realpath(workspaceRoot)
  const created = await mkdtemp(join(tmpdir(), 'orchestra-win-view-'))
  const close = async () => { await rm(created, { recursive: true, force: true }) }
  let view: string
  try {
    await populate(created)
    const shape = await lstat(created)
    view = await realpath(created)
    const position = relative(root, view)
    if (!shape.isDirectory() || shape.isSymbolicLink()
      || (!isAbsolute(position) && position !== '..' && !position.startsWith('..\\'))) {
      throw new OrchError('FORBIDDEN', 'Windows 只读宿主需要独立的临时工作区视图')
    }
  } catch (error) {
    await close()
    throw error
  }
  return {
    readonlyAvailable: () => true,
    close,
    async run(input) {
      if (!isAbsolute(input.bin) || !input.bin.toLowerCase().endsWith('.exe')
        || [input.bin, ...input.args].some((s) => s.includes('\0'))) {
        throw new OrchError('RUN_TOOL_NOT_READ_ONLY', 'Windows 只读宿主只执行固定的绝对 EXE 和参数')
      }
      if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 3_600_000) {
        throw new OrchError('PAYLOAD_SCHEMA_INVALID', 'Windows 只读命令超时须在 1 毫秒到 1 小时之间')
      }
      input.signal?.throwIfAborted()
      const logicalCwd = resolveInside(workspaceRoot, input.cwd)
      const cwd = await realpath(resolveInside(view, relative(workspaceRoot, logicalCwd)))
      resolveInside(view, cwd)
      const scratch = await mkdtemp(join(tmpdir(), 'orchestra-win-run-'))
      try {
        const result = join(scratch, 'result.json')
        const payload = Buffer.from(JSON.stringify({ bin: input.bin, argv: input.args.map(quoteArg).join(' '), cwd, scratch, result })).toString('base64')
        const script = encoded(worker.replace('PAYLOAD', payload))
        const identity = 'OrchestraTools' + randomUUID().replace(/-/gu, '')
        const request = { shell, encoded: script, spec: sandboxSpec(view, scratch), identity, view, result, timeout: input.timeoutMs }
        const data = await new Promise<string>((resolve, reject) => {
          const child = spawn(shell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded(launcher)], {
            windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
            env: { SystemRoot: windows, TEMP: process.env.TEMP, TMP: process.env.TMP },
          })
          const cancel = () => child.stdin.end()
          input.signal?.addEventListener('abort', cancel, { once: true })
          const timer = setTimeout(() => child.kill(), input.timeoutMs + 5000)
          child.stdin.on('error', () => {})
          child.stdin.write(JSON.stringify(request) + '\n')
          if (input.signal?.aborted) cancel()
          child.once('error', reject)
          let output = ''
          child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
            output += chunk
            if (output.length > 1024 * 1024) child.kill()
          })
          child.once('close', (code) => {
            clearTimeout(timer)
            input.signal?.removeEventListener('abort', cancel)
            child.stdin.destroy()
            if (input.signal?.aborted) reject(input.signal.reason)
            else if (code === 0 && output.length <= 1024 * 1024) resolve(output)
            else reject(new OrchError('EVIDENCE_SOURCE_UNAVAILABLE', 'Windows AppContainer 只读执行未取得可信回执'))
          })
        })
        const output = JSON.parse(data) as { exitCode?: number; stdout?: string; stderr?: string } | null
        if (typeof output?.exitCode !== 'number' || !Number.isInteger(output.exitCode)
          || typeof output.stdout !== 'string' || typeof output.stderr !== 'string') {
          throw new OrchError('EVIDENCE_SOURCE_UNAVAILABLE', 'Windows AppContainer 回执格式错误')
        }
        return { exitCode: output.exitCode, stdout: output.stdout, stderr: output.stderr, boundary: 'windows_appcontainer_bfs' }
      } finally {
        await rm(scratch, { recursive: true, force: true })
      }
    },
  }
}
