/**
 * The runner ids the registry resolves: the default runner and the legacy ids of saved records
 * (spec 2026-11-18-runner-definitions). Values only, so a module that needs the ids loads no
 * registry machinery (`core/runner-registry.ts`).
 */

/** The runner that a task with no runner, a legacy id or an unknown id gets. */
export const DEFAULT_RUNNER_ID = 'claude';

/** Legacy ids that old records carry, each with the runner it now names. */
export const LEGACY_RUNNER_IDS: ReadonlyMap<string, string> = new Map([['claude-cli', 'claude']]);
