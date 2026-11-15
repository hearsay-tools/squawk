import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'

/**
 * Process-launch isolation for the server unit suite (hearsay-tools/squawk#2369). A Stryker
 * mutant that turns an injected preview dependency into the real one
 * (`deps.launchBrowser ?? launchBrowser` → `&&` in `preview/host.ts`) starts a real Chromium,
 * or runs the fixture's `npm run dev` as a real dev server. This guard sits outside every mutated
 * source: it refuses a `child_process.spawn` made by the preview's two launch modules,
 * `preview/chromium.ts` (every Chromium launch) and `preview/dev-server.ts` (every dev server),
 * and records the refusal so the test fails even when the code under test swallowed the error.
 *
 * A test file that launches one on purpose calls `allowLaunches(kind)` at its top level; the
 * permission ends with that file. A `vi.mock('node:child_process')` in a file replaces the
 * patched function there, so a file that mocks spawn starts nothing and needs no permission.
 */

export type LaunchKind = 'browser' | 'dev-server'

export interface LaunchRefusal { kind: LaunchKind; command: string; stack: string }

interface GuardState { allowed: Set<LaunchKind>; refusals: LaunchRefusal[] }

const STATE_KEY = Symbol.for('cezar.test-launch-guard')
const REFUSED = 'ERR_TEST_LAUNCH_REFUSED'
/** Deep enough to reach the launch module through `spawnDetached` and Node's own frames. */
const STACK_FRAMES = 30

const LAUNCH_MODULES: ReadonlyArray<{ kind: LaunchKind; frame: RegExp }> = [
  { kind: 'browser', frame: /[\\/]src[\\/]preview[\\/]chromium\.[cm]?[jt]s:\d/ },
  { kind: 'dev-server', frame: /[\\/]src[\\/]preview[\\/]dev-server\.[cm]?[jt]s:\d/ },
]

/** One record per process: module isolation re-imports this file, but `child_process` is shared. */
function state(): GuardState {
  const global = globalThis as { [STATE_KEY]?: GuardState }
  global[STATE_KEY] ??= { allowed: new Set(), refusals: [] }
  return global[STATE_KEY]
}

/** The launch a call stack makes: the first preview launch module among its frames. */
export function launchKindOf(stack: string): LaunchKind | undefined {
  return LAUNCH_MODULES.find(module => module.frame.test(stack))?.kind
}

const NOUN: Record<LaunchKind, string> = { browser: 'a Chromium', 'dev-server': 'a dev server' }

const message = (kinds: LaunchKind[], commands: string[]): string =>
  `The test setup refused to start ${kinds.map(kind => NOUN[kind]).join(' and ')} (${commands.join(', ')}) (hearsay-tools/squawk#2369). ` +
  'A real preview dependency ran in place of the injected one. ' +
  `A test file that launches one on purpose calls allowLaunches(${kinds.map(kind => `'${kind}'`).join(', ')}) from src/test-launch-guard.testkit.ts.`

function callerStack(): string {
  const limit = Error.stackTraceLimit
  Error.stackTraceLimit = STACK_FRAMES
  try {
    return new Error('launch').stack ?? ''
  } finally {
    Error.stackTraceLimit = limit
  }
}

/**
 * Patches `child_process.spawn` once per process and syncs the ESM named export, so
 * `import { spawn } from 'node:child_process'` sees it. Each call (one per test file) clears the
 * permissions the previous file asked for.
 */
export function installLaunchGuard(): void {
  const guard = state()
  guard.allowed.clear()
  const module = childProcess as typeof childProcess & { [STATE_KEY]?: true }
  if (module[STATE_KEY]) return
  module[STATE_KEY] = true

  const spawn = childProcess.spawn as (...args: unknown[]) => childProcess.ChildProcess
  childProcess.spawn = function guardedSpawn(...args: unknown[]): childProcess.ChildProcess {
    const stack = callerStack()
    const kind = launchKindOf(stack)
    if (kind === undefined || guard.allowed.has(kind)) return spawn(...args)
    const command = [args[0], ...(Array.isArray(args[1]) ? args[1] : [])].map(String).join(' ')
    guard.refusals.push({ kind, command, stack })
    throw Object.assign(new Error(message([kind], [command])), { code: REFUSED })
  } as typeof childProcess.spawn
  syncBuiltinESMExports()
}

/** Lets the rest of this test file start real launches of `kinds`. */
export function allowLaunches(...kinds: LaunchKind[]): void {
  for (const kind of kinds) state().allowed.add(kind)
}

/** The refusals recorded since the last call. */
export function takeLaunchRefusals(): LaunchRefusal[] {
  return state().refusals.splice(0)
}

/** Throws the refusals recorded since the last call: the test setup runs it after each test. */
export function throwLaunchRefusals(): void {
  const taken = takeLaunchRefusals()
  if (taken.length === 0) return
  const error = new Error(message([...new Set(taken.map(refusal => refusal.kind))], [...new Set(taken.map(refusal => refusal.command))]))
  error.stack = `${error.message}\nFirst refused at:\n${taken[0]?.stack ?? ''}`
  throw error
}
