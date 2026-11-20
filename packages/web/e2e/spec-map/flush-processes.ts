import { existsSync, readdirSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

/**
 * Run by the `E2E spec map` workflow after the suite: every captured process still running gets
 * SIGTERM, which makes node-preload.mjs write its coverage, and the step waits until each one has.
 */

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

/** The pids in `directory` that recorded `started-<pid>.json` and wrote no coverage yet. */
export function pending(directory: string): number[] {
  if (!existsSync(directory)) return []
  const names = readdirSync(directory)
  return names.map((name) => /^started-(\d+)\.json$/.exec(name)?.[1]).filter((pid): pid is string => pid !== undefined)
    .filter((pid) => !names.some((name) => name.startsWith(`coverage-${pid}-`) && name.endsWith('.json'))).map(Number)
}

export async function flushProcesses(directory: string, { timeoutMs = 20_000, intervalMs = 200 } = {}) {
  const running = pending(directory).filter(alive)
  for (const pid of running) {
    try { process.kill(pid, 'SIGTERM') } catch { /* It exited meanwhile. */ }
  }
  // bound: a process that ignores SIGTERM leaves the loaded list out of the map, never the job hanging.
  for (const end = Date.now() + timeoutMs; Date.now() < end && pending(directory).some(alive);) await sleep(intervalMs)
  return { signalled: running.length, unflushed: pending(directory) }
}

if (import.meta.main) {
  const { signalled, unflushed } = await flushProcesses(process.argv[2]!)
  console.log(`Signalled ${signalled} running process(es); ${unflushed.length} left no coverage${unflushed.length ? `: ${unflushed.join(', ')}` : ''}.`)
}
