import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { testHome } from './home/test-home.testkit.ts'
import { launchBrowser } from './preview/browser-launch.ts'
import { launchChromium } from './preview/chromium.ts'
import { DevServer } from './preview/dev-server.ts'
import { ChromiumMissingError, PreviewHost, type PreviewHostDeps, type RunContext } from './preview/host.ts'
import { fakeStore, server } from './preview/host.testkit.ts'
import { fakeViewer } from './preview/preview.testkit.ts'
import { launchKindOf, takeLaunchRefusals } from './test-launch-guard.testkit.ts'

/**
 * The launch guard the test setup installs (hearsay-tools/squawk#2369): every path that starts a
 * real Chromium or dev server is refused in a file that did not call `allowLaunches`, including the
 * real dependencies `PreviewHost` falls back to when a test injects none.
 */

const REFUSED = { code: 'ERR_TEST_LAUNCH_REFUSED' }
const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cez-launch-guard-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** A directory whose `chromium` is the first Chromium `resolveChromium` finds on PATH. */
function chromiumOnPath(): string {
  const dir = scratch()
  const bin = join(dir, 'chromium')
  writeFileSync(bin, '#!/bin/sh\nexit 0\n')
  chmodSync(bin, 0o755)
  return dir
}

/** A host that falls back to the real dependencies `deps` leaves out, as a `??` → `&&` mutant does. */
function defaultHost(deps: Omit<PreviewHostDeps, 'home'>) {
  const root = scratch()
  const host = new PreviewHost({ home: testHome(deps.env), platform: 'linux', arch: 'x64', osRelease: () => 'ID=ubuntu\n', ...deps })
  cleanups.push(() => host.close())
  const ctx: RunContext = {
    runId: 'run-1', title: 'Guard the launch', worktreePath: root, dataDir: join(root, 'data'),
    store: fakeStore([server(5173)]) as unknown as RunContext['store'],
  }
  return { host, ctx }
}

const refusedKinds = () => takeLaunchRefusals().map(refusal => refusal.kind)

describe('launchKindOf', () => {
  it('names the launch by the preview module on the stack', () => {
    expect(launchKindOf('Error\n    at spawnDetached (/w/packages/cezar/src/detached-process.ts:41:10)\n    at launchOnce (/w/packages/cezar/src/preview/chromium.ts:477:16)')).toBe('browser')
    expect(launchKindOf('Error\n    at DevServer.start (C:\\w\\packages\\cezar\\src\\preview\\dev-server.ts:145:9)')).toBe('dev-server')
  })

  it('leaves other spawns, and the tests of those modules, alone', () => {
    expect(launchKindOf('Error\n    at spawnOwned (/w/packages/cezar/src/detached-process.ts:68:17)\n    at /w/packages/cezar/src/preview/chromium.test.ts:12:3')).toBeUndefined()
    expect(launchKindOf('Error\n    at run (/w/packages/cezar/src/runner/claude.ts:10:3)')).toBeUndefined()
  })
})

// The refusal stubs and the launch modules' process groups are POSIX.
describe.skipIf(process.platform === 'win32')('the launch guard', () => {
  it('refuses a direct Chromium launch', async () => {
    await expect(launchChromium('/bin/true', join(scratch(), 'profile'), {})).rejects.toMatchObject(REFUSED)
    expect(refusedKinds()).toEqual(['browser'])
  })

  it('refuses the browser-launch path to a Chromium found on PATH', async () => {
    const env = { PATH: chromiumOnPath() }
    await expect(launchBrowser(join(scratch(), 'profile'), env, testHome(env))).rejects.toMatchObject(REFUSED)
    expect(refusedKinds()).toEqual(['browser'])
  })

  it('refuses a dev server start', () => {
    const root = scratch()
    const dev = new DevServer({ server: server(5173, { command: 'true' }), worktreePath: root, dir: join(root, 'preview') })
    expect(() => dev.start()).toThrow(expect.objectContaining(REFUSED))
    expect(refusedKinds()).toEqual(['dev-server'])
  })

  it("refuses the host's default browser when a test injects none", async () => {
    const env = { PATH: chromiumOnPath() }
    const { host, ctx } = defaultHost({ env, createServer: () => { throw new Error('not reached') } })
    await host.open(ctx, fakeViewer(), { url: 'http://localhost:3000/' })
    expect(refusedKinds()).toEqual(['browser'])
  })

  it("refuses the host's default dev server when a test injects none", async () => {
    const { host, ctx } = defaultHost({ probe: async () => false, launchBrowser: async () => { throw new ChromiumMissingError() } })
    await host.open(ctx, fakeViewer(), { port: 5173 })
    await expect(host.run(ctx.runId, 5173)).rejects.toMatchObject(REFUSED)
    expect(refusedKinds()).toEqual(['dev-server'])
  })
})
