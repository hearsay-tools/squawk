import { spawn, type ChildProcess } from 'node:child_process'
import { resolve } from 'node:path'
import { pollFor } from './poll'
import { stopFixtureServer } from './fixture-server'

const announcements = new WeakMap<ChildProcess, () => string | undefined>()

export function spawnViteFixture(): ChildProcess {
  const child = spawn(process.execPath, [resolve(import.meta.dirname, 'fixtures/vite-server.mjs')], {
    cwd: resolve(import.meta.dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = '', failure: Error | undefined
  child.stdout!.setEncoding('utf8')
  child.stdout!.on('data', chunk => { output = (output + String(chunk)).slice(-16_384) })
  child.stderr!.on('data', () => {})
  child.once('error', error => { failure = error })
  announcements.set(child, () => {
    if (failure) throw failure
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('Vite fixture exited before readiness')
    return /^fixture → (http:\/\/127\.0\.0\.1:\d+)\r?$/m.exec(output)?.[1]
  })
  return child
}

export async function waitForViteFixture(child: ChildProcess): Promise<string> {
  try {
    return await pollFor(() => announcements.get(child)!(), () => 'Vite did not announce its listener', { timeoutMs: 45_000 })
  } catch (error) {
    await stopFixtureServer(child)
    throw error
  }
}
