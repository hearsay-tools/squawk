/**
 * The report of `profile-lint.ts --compare` (hearsay-tools/squawk#4238): pure functions over the
 * rounds that the script measured, so a test can pin the format without running oxlint.
 */

export interface CompareMeasure { user: number; sys: number }

/** One alternating round: base, then candidate, each with its user-CPU run and its `--debug timings` run. */
export interface CompareRound {
  /** The 1-minute load before each user-CPU run of the round. */
  loads: number[];
  base: CompareMeasure;
  candidate: CompareMeasure;
  baseTimings: Record<string, number>;
  candidateTimings: Record<string, number>;
}

export interface CompareInput { base: string; command: string; rounds: CompareRound[]; cores: number }

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle] ?? Number.NaN;
  return sorted.length % 2 === 1 ? upper : ((sorted[middle - 1] ?? Number.NaN) + upper) / 2;
}

/** The `cez/*` rows of oxlint's `--debug timings` table: rule name to JS milliseconds. */
export function ruleTimings(output: string): Record<string, number> {
  const timings: Record<string, number> = {};
  for (const line of output.split('\n')) {
    const [name, ms] = line.trim().split(/\s+/);
    if (name?.startsWith('cez/') && Number.isFinite(Number(ms))) timings[name] = Number(ms);
  }
  return timings;
}

const sum = (timings: Record<string, number>) => Object.values(timings).reduce((total, ms) => total + ms, 0);
const fixed = (value: number, digits = 2) => value.toFixed(digits);
const ratio = (candidate: number, base: number) => (base > 0 ? fixed(candidate / base) : 'n/a');

function sideRow(label: string, measures: CompareMeasure[], timings: Record<string, number>[]): { row: string; user: number; js: number } {
  const users = measures.map(m => m.user);
  const user = median(users);
  const js = median(timings.map(sum));
  const row = `| ${label} | ${fixed(user)} | ${fixed(Math.min(...users))}–${fixed(Math.max(...users))} | ${fixed(median(measures.map(m => m.sys)))} | ${fixed(js, 0)} |`;
  return { row, user, js };
}

function ruleRows(rounds: readonly CompareRound[]): string[] {
  const names = [...new Set(rounds.flatMap(r => [...Object.keys(r.baseTimings), ...Object.keys(r.candidateTimings)]))];
  const rows = names.map(name => {
    const base = median(rounds.map(r => r.baseTimings[name] ?? 0));
    const candidate = median(rounds.map(r => r.candidateTimings[name] ?? 0));
    return { name, base, candidate };
  });
  rows.sort((a, b) => b.candidate - a.candidate || a.name.localeCompare(b.name));
  return rows.map(r => `| ${r.name} | ${fixed(r.base, 0)} | ${fixed(r.candidate, 0)} | ${r.candidate - r.base >= 0 ? '+' : ''}${fixed(r.candidate - r.base, 0)} |`);
}

/** The Markdown report: per-side medians and ranges, the ratios, host load against the ceiling, and per-rule JS time. */
export function compareReport({ base, command, rounds, cores }: CompareInput): string {
  const baseSide = sideRow('base', rounds.map(r => r.base), rounds.map(r => r.baseTimings));
  const candidateSide = sideRow('candidate', rounds.map(r => r.candidate), rounds.map(r => r.candidateTimings));
  const load = median(rounds.flatMap(r => r.loads));
  const ceiling = cores / 2;
  const lines = [
    `Base: ${base}. Candidate: the working tree. Command: ${command}; ${rounds.length} alternating rounds; CPU in seconds, JS time in ms.`,
    '',
    '| Side | User median | User range | Sys median | `cez/*` JS ms median |',
    '| --- | ---: | ---: | ---: | ---: |',
    baseSide.row,
    candidateSide.row,
    '',
    `Candidate/base: user CPU ${ratio(candidateSide.user, baseSide.user)}, \`cez/*\` JS time ${ratio(candidateSide.js, baseSide.js)}.`,
    `Host: ${cores} cores; median 1-minute load ${fixed(load)}; user-CPU ceiling ${fixed(ceiling)} (half the cores).`,
  ];
  if (load >= ceiling) lines.push('', '**Load above ceiling: user CPU is not evidence; report the `--debug timings` sums.**');
  lines.push('', '| Rule | Base ms | Candidate ms | Delta |', '| --- | ---: | ---: | ---: |', ...ruleRows(rounds));
  return lines.join('\n');
}
