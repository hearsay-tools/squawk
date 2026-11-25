import { bundledRunnerIds } from '../plugin/bundled-runners.ts';

/**
 * The ids of the runners Squawk bundles, in display order: the folders under `runners/` with a
 * plugin entry (`plugin/bundled-runners.ts`). Importing this module loads no runner definition and
 * no adapter, which is why the global test setup (`vitest.setup.ts`) can read it and why the
 * closure guard (`core/runner-closure.test.ts`) keeps it free of runner code. A test that needs
 * the definitions registers them with `core/bundled-runners.testkit.ts`.
 */
export const BUILT_IN_RUNNER_IDS: readonly string[] = Object.freeze(bundledRunnerIds());
