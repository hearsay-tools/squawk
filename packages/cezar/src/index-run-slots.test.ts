import { expect, it, vi } from 'vitest';

// Each bin imports index.ts, which seals the removal slots before the CLI dispatch, so every
// command, the cockpit, a headless task and each child process that reruns the entry can delete,
// reclaim and archive runs (spec 2026-11-21-run-lifecycle-and-store-ports, "Removal slots"), and registers the
// worker executions every store builds on first use (hearsay-tools/squawk#4039).
vi.mock('./serve-command.ts', () => ({ defaultServeDeps: {}, serveCommand: vi.fn(async () => undefined) }));
vi.mock('./headless-run.ts', () => ({ defaultHeadlessDeps: {}, runHeadless: vi.fn(async () => undefined) }));

it.each(['./index.ts', './hsq.ts', './cez.ts', './cezarion.ts'])('%s seals the removal slots and registers the worker executions before the CLI dispatch runs', async (entry) => {
  vi.resetModules();
  const slots = await import('./runs/removal-slots.ts');
  const executions = await import('./runs/worker-executions-registry.ts');
  expect(slots.runSlotsSealed()).toBe(false);
  expect(executions.workerExecutionsRegistered()).toBe(false);
  let atDispatch: boolean[] | undefined;
  vi.doMock('./cli-dispatch.ts', () => ({ defaultCliDeps: {}, main: vi.fn(async () => { atDispatch = [slots.runSlotsSealed(), executions.workerExecutionsRegistered()]; }) }));
  await import(entry);
  expect(atDispatch).toEqual([true, true]);
});
