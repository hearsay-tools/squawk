import type { RunnerFacts } from './runner-facts.ts';
import { BUILT_IN_RUNNER_IDS } from '../runners/ids.ts';

declare global {
  interface ImportMeta {
    /** Vite's static glob import: Vitest compiles it into one import per matched file. */
    glob<T>(pattern: string, options: { eager: true }): Record<string, T>;
  }
}

// Every built-in runner's facts, read from the data-only `runners/<id>/facts.ts` files, for the
// static test tables that span every runner: the parity exemptions and the rows they pick. A
// per-runner test registers only its own definition, yet such a table must still see every
// runner, or it would drop rows. Importing these files loads no adapter, so the closure guard
// (`runner-closure.test.ts`) holds. Engine reads in tests go through the registry.
// `runner-fact-rows.test.ts` holds these rows to the registered definitions.
const FACT_MODULES = import.meta.glob<Readonly<Record<string, RunnerFacts>>>('../runners/*/facts.ts', { eager: true });
const EXTRA_TOOL_MODULES = import.meta.glob<Readonly<Record<string, readonly string[]>>>('../runners/*/extra-tools.ts', { eager: true });

/** The one value each built-in runner's `runners/<id>/<file>` exports, by runner id, in
 *  `BUILT_IN_RUNNER_IDS` order. */
function rowsOf<T>(modules: Record<string, Readonly<Record<string, T>>>, file: string): Readonly<Record<string, T>> {
  return Object.fromEntries(BUILT_IN_RUNNER_IDS.map(id => {
    const path = `../runners/${id}/${file}`;
    const module = modules[path];
    if (!module) throw new Error(`Runner ${id} has no ${path}.`);
    const values = Object.values(module);
    if (values.length !== 1) throw new Error(`${path} must export one value; it exports ${values.length}.`);
    return [id, values[0]!];
  }));
}

const ROWS = rowsOf(FACT_MODULES, 'facts.ts');

const EXTRA_TOOL_ROWS = rowsOf(EXTRA_TOOL_MODULES, 'extra-tools.ts');

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
