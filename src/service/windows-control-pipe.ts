import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { isAbsolute, join } from 'node:path'
import { Readable } from 'node:stream'

// Windows PowerShell and .NET are part of Windows. The broker owns the pipe
// security descriptor and forwards bytes to the existing loopback HTTP server.
const broker = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.IO;
using System.IO.Pipes;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;

public static class OrchestraPipe {
    [StructLayout(LayoutKind.Sequential)]
    struct SecurityAttributes {
        public int Length;
        public IntPtr Descriptor;
        public int Inherit;
    }

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(
        string text, uint revision, out IntPtr descriptor, IntPtr size);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern SafePipeHandle CreateNamedPipe(string path, uint openMode, uint pipeMode,
        uint maxInstances, uint outBuffer, uint inBuffer, uint timeout, ref SecurityAttributes security);

    static NamedPipeServerStream Open(string path, IntPtr descriptor, bool first) {
        const uint Duplex = 3;
        const uint Overlapped = 0x40000000;
        const uint FirstInstance = 0x00080000;
        const uint RejectRemote = 8;
        var security = new SecurityAttributes { Length = Marshal.SizeOf(typeof(SecurityAttributes)), Descriptor = descriptor };
        var handle = CreateNamedPipe(path, Duplex | Overlapped | (first ? FirstInstance : 0), RejectRemote, 8, 16384, 16384, 0, ref security);
        if (handle.IsInvalid) {
            int error = Marshal.GetLastWin32Error();
            handle.Dispose();
            throw new Win32Exception(error);
        }
        try { return new NamedPipeServerStream(PipeDirection.InOut, true, false, handle); }
        catch { handle.Dispose(); throw; }
    }

    static async Task Serve(string path, int port, IntPtr descriptor, NamedPipeServerStream pipe) {
        while (true) {
            using (pipe) {
                await pipe.WaitForConnectionAsync().ConfigureAwait(false);
                try {
                    using (var tcp = new TcpClient(AddressFamily.InterNetwork)) {
                        tcp.NoDelay = true;
                        await tcp.ConnectAsync(IPAddress.Loopback, port).ConfigureAwait(false);
                        using (var stream = tcp.GetStream()) {
                            var toServer = pipe.CopyToAsync(stream);
                            var toClient = stream.CopyToAsync(pipe);
                            var completed = await Task.WhenAny(toServer, toClient, Task.Delay(TimeSpan.FromMinutes(5))).ConfigureAwait(false);
                            if (completed == toClient) await toClient.ConfigureAwait(false);
                        }
                    }
                } catch (IOException) { }
                  catch (SocketException) { }
            }
            pipe = Open(path, descriptor, false);
        }
    }

    public static void Run(string path, int port) {
        string sid = WindowsIdentity.GetCurrent().User.Value;
        IntPtr descriptor;
        if (!ConvertStringSecurityDescriptorToSecurityDescriptor("O:" + sid + "D:P(A;;GA;;;" + sid + ")", 1, out descriptor, IntPtr.Zero))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        var workers = new Task[9];
        for (int i = 0; i < 8; i++) workers[i] = Serve(path, port, descriptor, Open(path, descriptor, i == 0));
        workers[8] = Task.Factory.StartNew(() => Console.In.Read(), TaskCreationOptions.LongRunning);
        Console.WriteLine("ready");
        Console.Out.Flush();
        // A listener failure stops the whole pipe. EOF also stops the broker when its parent exits.
        // The descriptor is process-scoped and remains valid until all listeners exit with it.
        Task.WhenAny(workers).GetAwaiter().GetResult().GetAwaiter().GetResult();
    }
}
'@
[OrchestraPipe]::Run($env:ORCHESTRA_PIPE_PATH, [int]$env:ORCHESTRA_LOOPBACK_PORT)
`

export type WindowsControlPipe = { path: string; close(): Promise<void> }

export async function openWindowsControlPipe(port: number): Promise<WindowsControlPipe | undefined> {
  const root = process.env.SystemRoot
  if (process.platform !== 'win32' || !root || !isAbsolute(root)) return
  const path = `\\\\.\\pipe\\dsh-orchestra-${randomBytes(16).toString('hex')}`
  const command = Buffer.from(broker, 'utf16le').toString('base64')
  const child = spawn(join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', command], {
      stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
      env: { SystemRoot: root, TEMP: process.env.TEMP, TMP: process.env.TMP,
        ORCHESTRA_PIPE_PATH: path, ORCHESTRA_LOOPBACK_PORT: String(port) },
    })
  const stopped = new Promise<void>((resolve) => { child.once('close', () => resolve()) })
  child.stdin.on('error', () => {})
  const close = async () => {
    child.stdin.end()
    const timeout = setTimeout(() => child.kill(), 1000)
    try { await stopped } finally { clearTimeout(timeout) }
  }
  const ready = await new Promise<boolean>((resolve) => {
    let output = ''
    const finish = (ok: boolean) => { clearTimeout(timeout); resolve(ok) }
    const timeout = setTimeout(() => finish(false), 4000)
    child.once('error', () => finish(false))
    void stopped.then(() => finish(false))
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      output += chunk
      if (output.length > 256) finish(false)
      else if (output.trim() === 'ready') finish(true)
    })
  })
  if (ready) return { path, close }
  await close()
}

// Only an unsuccessful connection can fall back. Once a server accepted a
// connection, a lost response could hide a committed control command.
export function requestControlPipe(socketPath: string, target: URL, options: {
  method: string; headers: Headers; signal: AbortSignal; body?: Uint8Array
}): Promise<Response | undefined> {
  return new Promise((resolve, reject) => {
    let connected = false
    const request = httpRequest({ socketPath, path: target.pathname + target.search,
      method: options.method, headers: Object.fromEntries(options.headers), signal: options.signal, agent: false }, (message) => {
      const headers = new Headers()
      for (const [name, value] of Object.entries(message.headers)) {
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value)
      }
      const status = message.statusCode ?? 502
      const body = status === 204 || status === 304 || status === 205 ? null : Readable.toWeb(message) as ReadableStream<Uint8Array>
      if (!body) message.resume()
      resolve(new Response(body, { status, headers }))
    })
    request.on('socket', (socket) => {
      socket.once('connect', () => { connected = true })
    })
    request.once('error', (error: NodeJS.ErrnoException) => {
      if (!connected && !options.signal.aborted && ['ENOENT', 'ECONNREFUSED', 'EACCES', 'EPERM', 'EBUSY'].includes(error.code ?? '')) resolve(undefined)
      else reject(error)
    })
    request.end(options.body)
  })
}
