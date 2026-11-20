import type { RunnerMock } from './runner-definition.ts';
import { BUILT_IN_RUNNER_IDS } from '../runners/ids.ts';

declare global {
  interface ImportMeta {
    /** Vite's static glob import: Vitest compiles it into one import per matched file. */
    glob<T>(pattern: string, options: { eager: true }): Record<string, T>;
  }
}

// Every built-in runner's `mock` part, read from the data-only `runners/<id>/mock.ts` files, for the
// static parity tables that span every runner (the exemptions each runner declares). Like the fact
// rows (`runner-fact-rows.testkit.ts`), these tables build in a test that registers no runner, so
// they read the data files, not the registry. Importing them loads no adapter, so the closure
// guard (`runner-closure.test.ts`) holds.
const MOCK_MODULES = import.meta.glob<Readonly<Record<string, RunnerMock>>>('../runners/*/mock.ts', { eager: true });

const MOCK_ROWS: Readonly<Record<string, RunnerMock>> = Object.fromEntries(BUILT_IN_RUNNER_IDS.map(id => {
  const path = `../runners/${id}/mock.ts`;
  const module = MOCK_MODULES[path];
  if (!module) throw new Error(`Runner ${id} has no ${path}.`);
  const values = Object.values(module);
  if (values.length !== 1) throw new Error(`${path} must export one value; it exports ${values.length}.`);
  return [id, values[0]!];
}));

/** Every built-in runner's `mock` part, by runner id, in `BUILT_IN_RUNNER_IDS` order. */
export function mockRows(): Readonly<Record<string, RunnerMock>> {
  return MOCK_ROWS;
}
