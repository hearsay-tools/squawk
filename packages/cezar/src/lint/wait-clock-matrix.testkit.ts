import { readFileSync } from 'node:fs';

/** Clock/value-flow parity fixtures pinned to the original scanners (hearsay-tools/squawk#3774). */
export type ClockProfile = 'server' | 'unit';
export type ClockRule = 'sleep' | 'short-bound' | 'poll-deadline';
export type ClockCounts = Record<ClockRule, number>;
export type ClockConsumer = 'direct' | 'timeout' | 'spread' | 'computed' | 'counter' | 'alias' | 'inline';

export interface ClockCase {
  id: string;
  code: string;
  clock: string;
  limit: string;
  consumer: ClockConsumer;
}

const clocks = [
  { id: 'date', expression: 'Date.now()' },
  { id: 'performance', expression: 'performance.now()' },
  { id: 'hrtime', expression: 'process.hrtime()' },
  { id: 'bigint', expression: 'process.hrtime.bigint()' },
];
const limits = [
  { id: 'literal', expression: '20_000' },
  { id: 'external', expression: 'external' },
  { id: 'property', expression: 'options.timeout' },
];
const consumers: ClockConsumer[] = ['direct', 'timeout', 'spread', 'computed', 'counter', 'alias', 'inline'];

function consumerSource(consumer: ClockConsumer, clock: string, limit: string): string {
  switch (consumer) {
    case 'direct': return `while (${clock} < deadline) await sleep(10);`;
    case 'timeout': return 'await vi.waitFor(() => {}, { timeout: deadline });';
    case 'spread': return 'await vi.waitFor(() => {}, { ...deadline });';
    case 'computed': return 'await vi.waitFor(() => {}, { [deadline]: 20_000 });';
    case 'counter': return 'for (let i = 0; i < deadline; i++) await sleep(10);';
    case 'alias': return `const alias = deadline; while (${clock} < alias) await sleep(10);`;
    case 'inline': return `const start = ${clock}; while (${clock} < start + ${limit}) await sleep(10);`;
  }
}

/** Four clocks, three limit origins and seven consumers produce 84 stable snippets. */
export function clockCases(): ClockCase[] {
  return clocks.flatMap(clock => limits.flatMap(limit => consumers.map(consumer => ({
    id: `${clock.id}/${limit.id}/${consumer}`,
    code: `const deadline = ${clock.expression} + ${limit.expression};\n${consumerSource(consumer, clock.expression, limit.expression)}`,
    clock: clock.expression,
    limit: limit.expression,
    consumer,
  }))));
}

/** Compare full rule classifications, including findings a narrower fixture helper filters out. */
export function siteCounts(sites: readonly { rule: string }[]): ClockCounts {
  const counts: ClockCounts = { sleep: 0, 'short-bound': 0, 'poll-deadline': 0 };
  for (const site of sites) {
    if (!Object.hasOwn(counts, site.rule)) throw new Error(`Unknown wait rule ${site.rule}`);
    counts[site.rule as ClockRule] += 1;
  }
  return counts;
}

interface ClockOracle {
  baselineSHA: string;
  counts: Record<ClockProfile, Record<string, ClockCounts>>;
}
let oracle: ClockOracle | undefined;

/** Expected findings were measured once from the baseline scanners, never from the port. */
export function oracleCounts(profile: ClockProfile, id: string): ClockCounts {
  oracle ??= JSON.parse(readFileSync(new URL('./wait-clock-matrix.json', import.meta.url), 'utf8')) as ClockOracle;
  const counts = oracle.counts[profile][id];
  if (!counts) throw new Error(`Missing ${profile} clock oracle for ${id}`);
  return counts;
}
