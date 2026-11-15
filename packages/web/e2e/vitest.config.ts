import { checkWorkspaceResolution } from '../../../scripts/check-workspace-resolution.mjs'
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import CockpitTestSequencer, { fileShuffleRequested } from '../../../.github/scripts/cockpit-test-sequencer.mjs'

checkWorkspaceResolution()

const shuffleFiles = fileShuffleRequested()
class CliCockpitTestSequencer extends CockpitTestSequencer {
  shuffleFiles = shuffleFiles
}

/**
 * The root configuration exposes this project to Squeal's slow tier. `npm test` selects
 * only unit projects, so the fast gate never needs a server or browser. The run environment
 * (`environment.ts`) prepares the environment for each test run, also when Squeal runs a
 * browser file directly; `npm run test:e2e` also bootstraps first so it can preserve the
 * wrapper's passed/failed/skipped contract.
 *
 * Plain node environment and no React plugin — the specs shell out to agent-browser and drive
 * a real Chrome; nothing here is bundled or rendered in jsdom.
 */
export default defineConfig({
  plugins: [{
    name: 'cez-e2e-run-environment',
    // A reporter sees each test run start and end, where a globalSetup sees only the Vitest
    // instance. Added here, before Vitest creates its reporters, because Squeal and other
    // callers replace the configured `reporters` (hearsay-tools/squawk#3538).
    configureVitest({ vitest, project }) {
      vitest.config.reporters.push([resolve(import.meta.dirname, 'environment.ts'), { project: project.name }])
    },
  }],
  test: {
    name: 'e2e',
    root: import.meta.dirname,
    environment: 'node',
    // failure-setup names the running test for the seam's failure bundles and writes one for a
    // plain `expect` failure, so a red spec always leaves page state behind (#408).
    setupFiles: ['../../../scripts/test-browser-home-env.mjs', './fetch-setup.mjs', './artifacts-setup.ts', './failure-setup.ts'],
    include: ['**/*.e2e.ts'],
    // One browser session, one server: parallel specs would fight over both.
    fileParallelism: false,
    sequence: { sequencer: CliCockpitTestSequencer },
    // A real browser is slower than jsdom, but a smoke test that needs more than this is broken.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})
