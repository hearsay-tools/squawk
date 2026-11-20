import { BUILT_IN_RUNNER_IDS } from '../runners/built-in.ts';
import type { RunnerFacts } from './runner-facts.ts';
import { CLAUDE_FACTS } from '../runners/claude/facts.ts';
import { CODEX_FACTS } from '../runners/codex/facts.ts';
import { OPENCODE_FACTS } from '../runners/opencode/facts.ts';
import { PI_FACTS } from '../runners/pi/facts.ts';
import { OMP_FACTS } from '../runners/omp/facts.ts';
import { CLAUDE_EXTRA_TOOLS } from '../runners/claude/extra-tools.ts';
import { CODEX_EXTRA_TOOLS } from '../runners/codex/extra-tools.ts';
import { OPENCODE_EXTRA_TOOLS } from '../runners/opencode/extra-tools.ts';
import { PI_EXTRA_TOOLS } from '../runners/pi/extra-tools.ts';
import { OMP_EXTRA_TOOLS } from '../runners/omp/extra-tools.ts';

// Every built-in runner's facts, read from the data-only `runners/<id>/facts.ts` files, for the
// static test tables that span every runner: the parity exemptions and the rows they pick. A
// per-runner test registers only its own definition, yet such a table must still see every
// runner, or it would drop rows. Importing these files loads no adapter, so the closure guard
// (`runner-closure.test.ts`) holds. Engine reads in tests go through the registry.
// `runner-fact-rows.test.ts` holds these rows to the registered definitions.
const ROWS: Readonly<Record<string, RunnerFacts>> = {
  claude: CLAUDE_FACTS, codex: CODEX_FACTS, opencode: OPENCODE_FACTS, pi: PI_FACTS, omp: OMP_FACTS,
};

const EXTRA_TOOL_ROWS: Readonly<Record<string, readonly string[]>> = {
  claude: CLAUDE_EXTRA_TOOLS, codex: CODEX_EXTRA_TOOLS, opencode: OPENCODE_EXTRA_TOOLS, pi: PI_EXTRA_TOOLS, omp: OMP_EXTRA_TOOLS,
};

/** Every built-in runner's `extraTools`, by runner id, for a table that crosses runners. */
export function extraToolRows(): Readonly<Record<string, readonly string[]>> {
  return EXTRA_TOOL_ROWS;
}

/** Every built-in runner's facts, by runner id. */
export function factRows(): Readonly<Record<string, RunnerFacts>> {
  return ROWS;
}

/** The built-in runners whose declared facts match, in `BUILT_IN_RUNNER_IDS` order. */
export function factsWhere(matches: (facts: RunnerFacts) => boolean): string[] {
  const rows = factRows();
  return BUILT_IN_RUNNER_IDS.filter(id => matches(rows[id]!));
}
