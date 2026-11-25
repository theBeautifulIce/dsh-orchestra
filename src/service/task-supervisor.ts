import { onLedgerCommit, type Db } from '../infra/sqlite/driver.ts'

export type SupervisorJob = { name: string; run(): void }
/** One writer-local event consumer; existing dispatcher remains the sole owner of dispatch. */
export function createTaskSupervisor(db: Db, options: {
  eventJobs: readonly SupervisorJob[]; periodicJobs: readonly SupervisorJob[];
  onError(name: string, error: unknown): void; debounceMs?: number; intervalMs?: number; eventDriven?: boolean;
}) {
  let closed = false, started = false
  let wake: ReturnType<typeof setTimeout> | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  let unsubscribe: (() => void) | undefined
  function run(jobs: readonly SupervisorJob[]) {
    for (const job of jobs) {
      if (closed) return
      try { job.run() } catch (error) {
        try { options.onError(job.name,error) } catch { /* isolate even diagnostic failure */ }
      }
    }
  }
  function poke() {
    if (closed || wake) return
    // Never run nested inside the writer transaction or recursively on its commit stack.
    wake = setTimeout(() => { wake = undefined; run(options.eventJobs) }, options.debounceMs ?? 50)
    wake.unref?.()
  }
  return {
    start() {
      if (closed || started) return
      started=true
      if (options.eventDriven!==false) unsubscribe=onLedgerCommit(db,poke)
      timer=setInterval(()=>{
        run(options.periodicJobs)
        clearTimeout(wake); wake=undefined
        run(options.eventJobs)
      },options.intervalMs ?? 2000)
      timer.unref?.()
      if(options.eventDriven===false)run(options.eventJobs);else poke()
    },
    poke,
    close() {
      closed=true
      unsubscribe?.()
      clearTimeout(wake)
      clearInterval(timer)
    },
  }
}
