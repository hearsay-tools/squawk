import type { RunnerFacts } from './runner-facts.ts';
import { runnerDataRows } from './runner-data-rows.testkit.ts';

// Every built-in runner's facts, read from the data-only `runners/<id>/facts.ts` files, for the
// static test tables that span every runner: the parity exemptions and the rows they pick. A
// per-runner test registers only its own definition, yet such a table must still see every
// runner, or it would drop rows. Importing these files loads no adapter, so the closure guard
// (`runner-closure.test.ts`) holds. Engine reads in tests go through the registry.
// `runner-fact-rows.test.ts` holds these rows to the registered definitions.
const ROWS = await runnerDataRows<RunnerFacts>('facts.ts', id => import(`../runners/${id}/facts.ts`));

const EXTRA_TOOL_ROWS = await runnerDataRows<readonly string[]>('extra-tools.ts', id => import(`../runners/${id}/extra-tools.ts`));

/** Every built-in runner's `extraTools`, by runner id, for a table that crosses runners. */
export function extraToolRows(): Readonly<Record<string, readonly string[]>> {
  return EXTRA_TOOL_ROWS;
}

/** Every built-in runner's facts, by runner id. */
export function factRows(): Readonly<Record<string, RunnerFacts>> {
  return ROWS;
}

/** The built-in runners whose declared facts match, in row order: the rows are the data files,
 *  read without the registry so a static table sees every runner even in a test that registers
 *  none. */
export function factsWhere(matches: (facts: RunnerFacts) => boolean): string[] {
  const rows = factRows();
  return Object.keys(rows).filter(id => matches(rows[id]!));
}
