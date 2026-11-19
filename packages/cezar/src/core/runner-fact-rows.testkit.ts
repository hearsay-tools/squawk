import { RUNNER_IDS, type RunnerId } from './agent-runner.ts';
import type { RunnerFacts } from './runner-facts.ts';
import { CLAUDE_FACTS } from '../runners/claude/facts.ts';
import { CODEX_FACTS } from '../runners/codex/facts.ts';
import { OPENCODE_FACTS } from '../runners/opencode/facts.ts';
import { PI_FACTS } from '../runners/pi/facts.ts';
import { OMP_FACTS } from '../runners/omp/facts.ts';

// Every built-in runner's facts, read from the data-only `runners/<id>/facts.ts` files, for the
// static test tables that span every runner: the parity exemptions and the rows they pick. A
// per-runner test registers only its own definition, yet such a table must still see every
// runner, or it would drop rows. Importing these files loads no adapter, so the closure guard
// (`runner-closure.test.ts`) holds. Engine reads in tests go through the registry.
// `runner-fact-rows.test.ts` holds these rows to the registered definitions.
const ROWS: Readonly<Record<RunnerId, RunnerFacts>> = {
  claude: CLAUDE_FACTS, codex: CODEX_FACTS, opencode: OPENCODE_FACTS, pi: PI_FACTS, omp: OMP_FACTS,
};

/** Every built-in runner's facts, by runner id. */
export function factRows(): Readonly<Record<RunnerId, RunnerFacts>> {
  return ROWS;
}

/** The built-in runners whose declared facts match, in `RUNNER_IDS` order. */
export function factsWhere(matches: (facts: RunnerFacts) => boolean): RunnerId[] {
  const rows = factRows();
  return RUNNER_IDS.filter(id => matches(rows[id]));
}
