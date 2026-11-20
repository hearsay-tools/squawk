import { BUILT_IN_RUNNER_IDS } from './runners/built-in.ts';
import { expect, it, vi } from 'vitest';
// The CLI entry registers the built-in runners before it dispatches, so every command, the
// cockpit, a headless task and each child process that reruns index.ts read runner data from the
// registry (spec 2026-11-18-runner-definitions).
const seen = vi.hoisted(() => ({ atDispatch: undefined as string[] | undefined }));
vi.mock('./cli-dispatch.ts', async () => {
  const { registeredRunners } = await import('./core/runner-registry.ts');
  return { defaultCliDeps: {}, main: vi.fn(async () => { seen.atDispatch = registeredRunners().map(definition => definition.id); }) };
});
vi.mock('./serve-command.ts', () => ({ defaultServeDeps: {}, serveCommand: vi.fn(async () => undefined) }));
vi.mock('./headless-run.ts', () => ({ defaultHeadlessDeps: {}, runHeadless: vi.fn(async () => undefined) }));

it('registers every built-in runner before the CLI dispatch runs', async () => {
  await import('./index.ts');
  expect(seen.atDispatch).toEqual([...BUILT_IN_RUNNER_IDS]);
});
