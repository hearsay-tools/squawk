import type { RunnerMock } from './runner-definition.ts';
import { runnerDataRows } from './runner-data-rows.testkit.ts';

// Every built-in runner's `mock` part, read from the data-only `runners/<id>/mock.ts` files, for the
// static parity tables that span every runner (the exemptions each runner declares). Like the fact
// rows (`runner-fact-rows.testkit.ts`), these tables build in a test that registers no runner, so
// they read the data files, not the registry. Importing them loads no adapter, so the closure
// guard (`runner-closure.test.ts`) holds.
const MOCK_ROWS = await runnerDataRows<RunnerMock>('mock.ts', id => import(`../runners/${id}/mock.ts`));

/** Every built-in runner's `mock` part, by runner id, in `BUILT_IN_RUNNER_IDS` order. */
export function mockRows(): Readonly<Record<string, RunnerMock>> {
  return MOCK_ROWS;
}
