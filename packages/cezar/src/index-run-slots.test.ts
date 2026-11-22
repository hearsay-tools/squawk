import { expect, it, vi } from 'vitest';

// Each bin imports index.ts, which seals the removal slots before the CLI dispatch, so every
// command, the cockpit, a headless task and each child process that reruns the entry can delete,
// reclaim and archive runs (spec 2026-11-21-run-lifecycle-and-store-ports, "Removal slots").
vi.mock('./serve-command.ts', () => ({ defaultServeDeps: {}, serveCommand: vi.fn(async () => undefined) }));
vi.mock('./headless-run.ts', () => ({ defaultHeadlessDeps: {}, runHeadless: vi.fn(async () => undefined) }));

it.each(['./index.ts', './hsq.ts', './cez.ts', './cezarion.ts'])('%s seals the removal slots before the CLI dispatch runs', async (entry) => {
  vi.resetModules();
  const slots = await import('./runs/removal-slots.ts');
  expect(slots.runSlotsSealed()).toBe(false);
  let atDispatch: boolean | undefined;
  vi.doMock('./cli-dispatch.ts', () => ({ defaultCliDeps: {}, main: vi.fn(async () => { atDispatch = slots.runSlotsSealed(); }) }));
  await import(entry);
  expect(atDispatch).toBe(true);
});
