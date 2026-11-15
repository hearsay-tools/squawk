import { checkWorkspaceResolution } from '../../../scripts/check-workspace-resolution.mjs'
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import type { Reporter, TestModule, TestSpecification } from 'vitest/node'
import { acquireTestEnvLease } from '../../../.ai/scripts/test-env-lease.mjs'
import { setup as pinWorkspaceRegistry } from './workspace-registry.ts'
import { tmpdirExceedsSocketBudget } from '../../../.ai/scripts/resolve-browser-launch.mjs'

checkWorkspaceResolution()

const exec = promisify(execFile)
const root = resolve(import.meta.dirname, '../../..')

const TEMP_KEYS = ['TMPDIR', 'TMP', 'TEMP'] as const

/**
 * Point TMPDIR/TMP/TEMP at a fresh short directory under /tmp when this caller's own temp dir
 * would overflow Chrome's SingletonSocket path. Returns the release: restore the previous values
 * (deleting the ones that were unset) and remove the directory. A no-op otherwise.
 */
export function useSocketSafeTmpdir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): () => void {
  if (!tmpdirExceedsSocketBudget(env, platform)) return () => {}
  const dir = mkdtempSync('/tmp/cez-e2e-')
  const previous = TEMP_KEYS.map((key) => [key, env[key]] as const)
  for (const key of TEMP_KEYS) env[key] = dir
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete env[key]
      else env[key] = value
    }
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Prepare browser E2E for one test run, even when Squeal drives Vitest directly, and return
 * the release. The lease keeps a stale TTL from tearing down an env a caller still uses
 * (hearsay-tools/cezarion#1304). */
export async function setup(): Promise<() => void> {
  const previousToken = process.env.TEST_ENV_LEASE_TOKEN
  const lease = await acquireTestEnvLease(root, {
    ...(previousToken === undefined ? {} : { token: previousToken }),
    onWait: message => console.error(`[test-env] ${message}`),
  })
  process.env.TEST_ENV_LEASE_TOKEN = lease.token
  let restoreTmpdir = () => {}
  let restoreRegistry = () => {}
  const release = () => {
    try { restoreRegistry() }
    finally {
      try { restoreTmpdir() }
      finally {
        if (previousToken === undefined) delete process.env.TEST_ENV_LEASE_TOKEN
        else process.env.TEST_ENV_LEASE_TOKEN = previousToken
        lease.release()
      }
    }
  }
  try {
    // The wrapper already bootstrapped with its requested --server-env flags. Booting
    // again here would discard those flags, and could replace our own server at the TTL.
    if (!(previousToken && process.env.TEST_ENV_LEASE_BOOTSTRAPPED === '1')) {
      const { stdout, stderr } = await exec('sh', [resolve(root, '.ai/scripts/test-env-up.sh')], {
        cwd: root,
        timeout: 300_000,
        maxBuffer: 8 * 1024 * 1024,
      })
      if (stdout.trim()) console.log(stdout.trim())
      if (stderr.trim()) console.error(stderr.trim())
    }
    const descriptor = JSON.parse(await readFile(resolve(root, '.ai/qa/test-env.json'), 'utf8')) as {
      browser?: { installed?: boolean; notes?: string }
    }
    if (descriptor.browser?.installed !== true) {
      throw new Error(`Browser E2E could not run: ${descriptor.browser?.notes ?? 'browser unavailable'}`)
    }
    // Decide from THIS caller's TMPDIR only after boot: the detached server must not
    // inherit a temporary directory that test teardown later removes.
    restoreTmpdir = useSocketSafeTmpdir()
    // Pin the shared env's workspace registry to the one-project shape before any spec runs,
    // and restore it before the lease goes. Otherwise whatever the operator last registered in
    // the gitignored `.ai/qa/cez-home` decides whether the sidebar renders its flat or its
    // grouped shell, and every spec that asserts flat-shell selectors becomes a coin flip.
    restoreRegistry = await pinWorkspaceRegistry()
    return release
  } catch (cause) {
    release()
    throw new Error('Browser E2E environment bootstrap failed', { cause })
  }
}

type RunEnvironmentOptions = { project?: string; prepare?: () => Promise<() => void> }

/**
 * Holds the environment, and so the lease, for each test run that needs it
 * (hearsay-tools/squawk#3538). A globalSetup runs once per Vitest instance and its teardown
 * runs only when that instance closes. A long-lived host, such as the Squeal daemon, would
 * keep its holder row for its whole life, and the app's idle watcher would never stop the app.
 *
 * Runs can overlap, and Vitest can end them in any order: it reports a run's start before the
 * run waits for an earlier one, and several runs that wait for the same earlier run all start
 * when it ends. So an end is never paired with a start by position. Each end is classified from
 * its own test modules: a browser run's modules include this project's. A run that ended before
 * Vitest registered any module (a crash before collection) has none, so it counts as a browser
 * run only when no other run is open. The browser count therefore never drops below the number
 * of browser runs still open, and the environment goes only when the last of them ends.
 */
export default class RunEnvironment implements Reporter {
  readonly #project: string
  readonly #prepare: () => Promise<() => void>
  /** Started browser runs that have not ended, including those still waiting for the environment. */
  #browserRuns = 0
  /** Started runs without this project's specs that have not ended. */
  #otherRuns = 0
  #environment: Promise<() => void> | undefined

  constructor({ project = 'e2e', prepare = setup }: RunEnvironmentOptions = {}) {
    this.#project = project
    this.#prepare = prepare
  }

  async onTestRunStart(specifications: ReadonlyArray<TestSpecification>): Promise<void> {
    if (!specifications.some(spec => spec.project.name === this.#project)) {
      this.#otherRuns++
      return
    }
    this.#browserRuns++
    const environment = (this.#environment ??= this.#prepare())
    try {
      await environment
    } catch (error) {
      // Vitest never ends a run whose start failed.
      this.#browserRuns--
      if (this.#environment === environment) this.#environment = undefined
      throw error
    }
  }

  async onTestRunEnd(testModules: ReadonlyArray<TestModule>): Promise<void> {
    const browser = testModules.some(module => module.project.name === this.#project) || this.#otherRuns === 0
    if (!browser) {
      this.#otherRuns--
      return
    }
    if (this.#browserRuns === 0 || --this.#browserRuns > 0) return
    const environment = this.#environment
    this.#environment = undefined
    // No browser run is open, so none still waits for this environment: it has resolved.
    ;(await environment)?.()
  }
}
