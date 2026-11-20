/**
 * The ids of the runners Squawk ships, in display order: plain data, the one roster of runner
 * ids (spec 2026-11-18-runner-definitions, decision 5). `runners/built-in.ts` holds the
 * definitions these ids name and checks the two lists match; importing this module loads no
 * definition and no adapter, which is why the global test setup reads it (`vitest.setup.ts`)
 * and why the closure guard (`core/runner-closure.test.ts`) keeps it free of runner code.
 */
export const BUILT_IN_RUNNER_IDS: readonly string[] = ['claude', 'codex', 'opencode', 'pi', 'omp'];
