/**
 * The wait-rule matrix (hearsay-tools/squawk#3774, slice 6b). Each cell is one test file that
 * waits in one way. `wait-matrix.oracle.json` holds what the text scanners of main
 * a78d9e79e reported for every cell, and `wait-matrix-<profile>.test.ts` check the oxlint rules against
 * it. The cells cross six axes:
 *
 * - the wait: sleeps, promised timers, Vitest waits, Testing Library waits, wait helpers, poll loops;
 * - the bound's value: literals, conversions, arithmetic, `Math.*`, wrappers, names from outside;
 * - the bound's source: inline, constants, aliases, reassignment, destructuring, parameters, scopes;
 * - the clock a poll loop reads, and how its deadline is consumed;
 * - the `// bound:` comment, and the function the wait sits in;
 * - the profile: server `.test.ts` and `.testkit.ts` (10 s floor), cockpit `.test.ts` and `.test.tsx` (3 s floor).
 *
 * The generator is deterministic: the same commit gives the same cells in the same order, so an
 * oracle row is found by its cell id.
 */

export interface Cell {
  /** `<tier>/<profile>/<wait>/<source>/<value>/<clock>/<comment>/<wrapper>`. */
  id: string;
  /** The repository path the cell is linted as. */
  file: string;
  code: string;
}

export interface Profile {
  key: string;
  file: string;
  /** A `.tsx` file: `<T>value` is JSX there, so values that use it are left out. */
  tsx: boolean;
}

export const PROFILES = {
  server: { key: 'server', file: 'packages/cezar/src/wait-matrix.test.ts', tsx: false },
  serverkit: { key: 'serverkit', file: 'packages/cezar/src/wait-matrix.testkit.ts', tsx: false },
  cockpit: { key: 'cockpit', file: 'packages/web/src/wait-matrix.test.tsx', tsx: true },
  cockpitts: { key: 'cockpitts', file: 'packages/web/src/wait-matrix.test.ts', tsx: false },
} satisfies Record<string, Profile>;

/** A bound's value, written as an expression. `angle` needs a `.ts` file. */
interface Value {
  key: string;
  text: string;
  angle?: true;
}

export const VALUES: Value[] = [
  { key: 'lit-500', text: '500' },
  { key: 'lit-2999', text: '2_999' },
  { key: 'lit-3000', text: '3_000' },
  { key: 'lit-5000', text: '5_000' },
  { key: 'lit-9999', text: '9_999' },
  { key: 'lit-10000', text: '10_000' },
  { key: 'lit-15000', text: '15_000' },
  { key: 'lit-0', text: '0' },
  { key: 'neg-0', text: '-0' },
  { key: 'neg-1', text: '-1' },
  { key: 'exp', text: '1e4' },
  { key: 'exp-short', text: '5e3' },
  { key: 'hex', text: '0x2710' },
  { key: 'float', text: '9999.5' },
  { key: 'max-timer', text: '2_147_483_647' },
  { key: 'over-timer', text: '2_147_483_648' },
  { key: 'infinity', text: 'Infinity' },
  { key: 'nan', text: 'NaN' },
  { key: 'max-safe', text: 'Number.MAX_SAFE_INTEGER' },
  { key: 'string', text: "'15000'" },
  { key: 'number-call', text: 'Number(15_000)' },
  { key: 'number-call-short', text: 'Number(500)' },
  { key: 'bigint-call', text: 'BigInt(15_000)' },
  { key: 'bigint-lit', text: '15_000n' },
  { key: 'mul', text: '5 * 1_000' },
  { key: 'mul-long', text: '15 * 1_000' },
  { key: 'add', text: '2_000 + 500' },
  { key: 'add-long', text: '9_000 + 1_000' },
  { key: 'sub', text: '20_000 - 15_000' },
  { key: 'paren', text: '(5_000)' },
  { key: 'paren-long', text: '((15_000))' },
  { key: 'as', text: '5_000 as number' },
  { key: 'as-long', text: '15_000 as number' },
  { key: 'as-const', text: '15_000 as const' },
  { key: 'satisfies', text: '15_000 satisfies number' },
  { key: 'nonnull', text: '5_000!' },
  { key: 'angle', text: '<number>5_000', angle: true },
  { key: 'angle-long', text: '<number>15_000', angle: true },
  { key: 'plus', text: '+15_000' },
  { key: 'double-neg', text: '-(-500)' },
  { key: 'pow', text: '2 ** 14' },
  { key: 'pow-short', text: '2 ** 10' },
  { key: 'div', text: '30_000 / 2' },
  { key: 'mod', text: '25_000 % 20_000' },
  { key: 'math-max', text: 'Math.max(500, 20_000)' },
  { key: 'math-min', text: 'Math.min(500, 20_000)' },
  { key: 'math-nested', text: 'Math.max(Math.min(500, 1_000), 20_000)' },
  { key: 'math-nested-short', text: 'Math.min(Math.max(500, 1_000), 20_000)' },
  { key: 'math-in-sum', text: 'Math.max(500, 1_000) + 14_000' },
  { key: 'math-floor', text: 'Math.floor(15_000.7)' },
  { key: 'math-round-short', text: 'Math.round(499.6)' },
  { key: 'math-random', text: 'Math.random()' },
  { key: 'ternary', text: 'ok ? 500 : 20_000' },
  { key: 'nullish', text: 'override ?? 500' },
  { key: 'call', text: 'compute()' },
  { key: 'template', text: '`15000`' },
  { key: 'external', text: 'EXTERNAL_MS' },
  { key: 'external-path', text: 'options.timeout' },
  { key: 'external-mul', text: 'options.timeout * 2' },
  { key: 'undefined', text: 'undefined' },
  { key: 'null', text: 'null' },
];

/** The values each family is crossed with when not every value is: short, long, unreadable and outside. */
export const FEW_VALUES = ['lit-500', 'lit-5000', 'lit-15000', 'lit-0', 'mul', 'mul-long', 'math-nested', 'as-long', 'call', 'external', 'external-path', 'number-call'];

/** Where a wait's bound comes from. `{V}` is the value; the wait reads `ref`. */
interface Source {
  key: string;
  ref: string;
  imports?: string[];
  moduleBefore?: string[];
  localBefore?: string[];
  localAfter?: string[];
  moduleAfter?: string[];
  /** The function around the wait, when it is not the default test callback. */
  wrap?: (body: string[]) => string[];
}

const indent = (lines: string[], by = '  '): string[] => lines.map(line => (line === '' ? line : by + line));

export const SOURCES: Source[] = [
  { key: 'inline', ref: '{V}' },
  { key: 'module-const', ref: 'LIMIT', moduleBefore: ['const LIMIT = {V};'] },
  { key: 'local-const', ref: 'LIMIT', localBefore: ['const LIMIT = {V};'] },
  { key: 'module-const-after', ref: 'LIMIT', moduleAfter: ['const LIMIT = {V};'] },
  { key: 'alias', ref: 'LIMIT', moduleBefore: ['const BASE = {V};'], localBefore: ['const LIMIT = BASE;'] },
  { key: 'alias-chain', ref: 'LIMIT', moduleBefore: ['const FIRST = {V};', 'const SECOND = FIRST;'], localBefore: ['const THIRD = SECOND;', 'const LIMIT = THIRD;'] },
  { key: 'alias-sum', ref: 'LIMIT', moduleBefore: ['const BASE = {V};'], localBefore: ['const LIMIT = BASE + 0;'] },
  { key: 'let-never', ref: 'LIMIT', localBefore: ['let LIMIT = {V};'] },
  { key: 'let-written-after', ref: 'LIMIT', localBefore: ['let LIMIT = {V};'], localAfter: ['LIMIT = 20_000;'] },
  { key: 'let-written-before', ref: 'LIMIT', localBefore: ['let LIMIT = 20_000;', 'LIMIT = {V};'] },
  { key: 'let-compound', ref: 'LIMIT', localBefore: ['let LIMIT = {V};', 'LIMIT += 0;'] },
  { key: 'let-unknown', ref: 'LIMIT', localBefore: ['let LIMIT = {V};', 'LIMIT = compute();'] },
  { key: 'let-uninit', ref: 'LIMIT', localBefore: ['let LIMIT;', 'LIMIT = {V};'] },
  { key: 'module-let', ref: 'LIMIT', moduleBefore: ['let LIMIT = {V};'] },
  { key: 'module-let-written', ref: 'LIMIT', moduleBefore: ['let LIMIT = {V};', "beforeEach(() => { LIMIT = 20_000; });"] },
  { key: 'var', ref: 'LIMIT', localBefore: ['var LIMIT = {V};'] },
  { key: 'destructure', ref: 'LIMIT', localBefore: ['const { LIMIT = {V} } = settings;'] },
  { key: 'destructure-renamed', ref: 'LIMIT', localBefore: ['const { limit: LIMIT = {V} } = settings;'] },
  { key: 'destructure-array', ref: 'LIMIT', localBefore: ['const [LIMIT = {V}] = list;'] },
  { key: 'member', ref: 'CONFIG.timeout', moduleBefore: ['const CONFIG = { timeout: {V} };'] },
  { key: 'shadow', ref: 'LIMIT', moduleBefore: ['const LIMIT = 20_000;'], localBefore: ['const LIMIT = {V};'] },
  { key: 'shadowed-long', ref: 'LIMIT', moduleBefore: ['const LIMIT = {V};'], localBefore: ['const LIMIT = 20_000;'] },
  { key: 'block-closed', ref: 'LIMIT', moduleBefore: ['const LIMIT = 20_000;'], localBefore: ['if (flag) {', '  const LIMIT = {V};', '  use(LIMIT);', '}'] },
  { key: 'outer-function', ref: 'LIMIT', wrap: body => ['describe(\'outer\', () => {', '  const LIMIT = {V};', "  it('waits', async () => {", ...indent(body, '    '), '  });', '});'] },
  {
    key: 'param-default', ref: 'LIMIT',
    wrap: body => ['async function run(LIMIT = {V}) {', ...indent(body), '}'],
  },
  {
    key: 'param-typed-default', ref: 'LIMIT',
    wrap: body => ['async function run(check: () => boolean, LIMIT: number = {V}): Promise<void> {', ...indent(body), '}'],
  },
  {
    key: 'arrow-param-default', ref: 'LIMIT',
    wrap: body => ['const run = async (LIMIT = {V}) => {', ...indent(body), '};'],
  },
];

/** Sources whose value is not `{V}`: crossed once, not with every value. */
export const FIXED_SOURCES: Source[] = [
  { key: 'param', ref: 'LIMIT', wrap: body => ['async function run(LIMIT: number) {', ...indent(body), '}'] },
  { key: 'import', ref: 'LIMIT', imports: ["import { LIMIT } from './limits';"] },
  { key: 'global', ref: 'LIMIT' },
  { key: 'options-path', ref: 'options.timeout' },
  { key: 'options-param', ref: 'options.timeout', wrap: body => ['async function run(options: { timeout: number }) {', ...indent(body), '}'] },
  { key: 'destructured-param', ref: 'LIMIT', wrap: body => ['async function run({ LIMIT }: { LIMIT: number }) {', ...indent(body), '}'] },
];

/** The sources each family is crossed with when not every source is. */
export const FEW_SOURCES = ['inline', 'module-const', 'local-const', 'alias', 'let-written-after', 'destructure', 'param-default'];

/** A clock read. */
export const CLOCKS: Record<string, string> = {
  date: 'Date.now()',
  performance: 'performance.now()',
  hrtime: 'process.hrtime()',
  bigint: 'process.hrtime.bigint()',
};

/** A wait, with `{X}` for the bound and `{K}` for the clock. `loop` marks a poll loop, which reads a clock. */
interface Wait {
  key: string;
  lines: string[];
  imports?: string[];
  loop?: true;
}

export const WAITS: Wait[] = [
  // Sleeps.
  { key: 'sleep', lines: ['await sleep({X});'] },
  { key: 'delay', lines: ['await delay({X});'] },
  { key: 'wait-pause', lines: ['await pause({X});'] },
  { key: 'timers-promise', lines: ['await setTimeout({X});'], imports: ["import { setTimeout } from 'node:timers/promises';"] },
  { key: 'timers-member', lines: ['await timers.setTimeout({X});'] },
  { key: 'promise-arrow', lines: ['await new Promise(r => setTimeout(r, {X}));'] },
  { key: 'promise-block', lines: ['await new Promise<void>((resolve) => { setTimeout(resolve, {X}); });'] },
  { key: 'promise-return', lines: ['await new Promise(r => { return setTimeout(r, {X}); });'] },
  { key: 'promise-global', lines: ['await new Promise(r => globalThis.setTimeout(r, {X}));'] },
  { key: 'promise-function', lines: ['await new Promise(function (done) { setTimeout(done, {X}); });'] },
  { key: 'promise-alias', lines: ['await new Promise(resolve => realSetTimeout(resolve, {X}));'] },
  { key: 'promise-multiline', lines: ['await new Promise((resolve) =>', '  setTimeout(resolve, {X}),', ');'] },
  { key: 'method-sleep', lines: ['await clock.sleep({X});'] },
  { key: 'unawaited-sleep', lines: ['void sleep({X});'] },
  { key: 'reject-timer', lines: ["await new Promise((_, reject) => setTimeout(() => reject(new Error('late')), {X}));"] },
  // Vitest waits.
  { key: 'vi-default', lines: ['await vi.waitFor(() => ready());'] },
  { key: 'vi-number', lines: ['await vi.waitFor(() => ready(), {X});'] },
  { key: 'vi-options', lines: ['await vi.waitFor(() => ready(), { timeout: {X} });'] },
  { key: 'vi-options-interval', lines: ['await vi.waitUntil(() => ready(), { interval: 10, timeout: {X} });'] },
  { key: 'vi-options-multiline', lines: ['await vi.waitFor(() => {', '  expect(ready()).toBe(true);', '}, {', '  interval: 20,', '  timeout: {X},', '});'] },
  { key: 'poll-options', lines: ['await expect.poll(() => count(), { timeout: {X} }).toBe(1);'] },
  { key: 'vi-bracket', lines: ["await vi['waitFor'](() => ready(), { timeout: {X} });"] },
  { key: 'vi-spread-before', lines: ['await vi.waitFor(() => ready(), { ...opts, timeout: {X} });'] },
  { key: 'vi-spread-after', lines: ['await vi.waitFor(() => ready(), { timeout: {X}, ...opts });'] },
  { key: 'vi-computed-key', lines: ["await vi.waitFor(() => ready(), { ['timeout']: {X} });"] },
  { key: 'vi-quoted-key', lines: ["await vi.waitFor(() => ready(), { 'timeout': {X} });"] },
  { key: 'vi-const-key', lines: ["const KEY = 'timeout';", 'await vi.waitFor(() => ready(), { [KEY]: {X} });'] },
  { key: 'vi-held-options', lines: ['const OPTIONS = { timeout: {X} };', 'await vi.waitFor(() => ready(), OPTIONS);'] },
  { key: 'vi-twice', lines: ['await vi.waitFor(() => ready(), { timeout: 20_000, timeout: {X} });'] },
  // Wait helpers and Testing Library.
  { key: 'helper-number', lines: ['await waitFor(() => ready(), {X});'] },
  { key: 'helper-label', lines: ["await until(() => ready(), 'the run to settle', {X});"] },
  { key: 'helper-eventually', lines: ['await eventually(() => ready(), {X});'] },
  { key: 'helper-method', lines: ['await harness.waitFor(() => ready(), {X});'] },
  { key: 'tl-options', lines: ['await waitFor(() => ready(), { timeout: {X} });'], imports: ["import { waitFor, screen } from '@testing-library/react';"] },
  { key: 'tl-find', lines: ["await screen.findByText('x', {}, { timeout: {X} });"], imports: ["import { screen } from '@testing-library/react';"] },
  { key: 'tl-namespace', lines: ['await rtl.waitFor(() => ready(), { timeout: {X} });'], imports: ["import * as rtl from '@testing-library/react';"] },
  { key: 'helper-default', lines: ['async function until(check: () => boolean, timeoutMs = {X}): Promise<void> {', '  await vi.waitFor(() => expect(check()).toBe(true), { timeout: timeoutMs });', '}'] },
  { key: 'helper-arrow-default', lines: ['const waitFor = async (check: () => boolean, timeout: number = {X}) => {', '  await vi.waitFor(() => expect(check()).toBe(true), { timeout });', '};'] },
  { key: 'helper-interval-default', lines: ['async function waitUntil(check: () => boolean, intervalMs = {X}): Promise<void> {}'] },
  // Poll loops.
  { key: 'loop-deadline', loop: true, lines: ['const deadline = {K} + {X};', 'while ({K} < deadline) {', '  if (ready()) break;', '  await sleep(10);', '}'] },
  { key: 'loop-deadline-exit', loop: true, lines: ['const deadline = {K} + {X};', 'while (!ready()) {', '  if ({K} >= deadline) throw new Error(\'late\');', '  await sleep(10);', '}'] },
  { key: 'loop-elapsed-exit', loop: true, lines: ['const start = {K};', 'while (!ready()) {', "  if ({K} - start > {X}) throw new Error('late');", '  await sleep(10);', '}'] },
  { key: 'loop-elapsed-head', loop: true, lines: ['const start = {K};', 'while ({K} - start < {X}) {', '  await sleep(10);', '}'] },
  { key: 'loop-sum-head', loop: true, lines: ['const start = {K};', 'while ({K} < start + {X}) await sleep(10);'] },
  { key: 'loop-inverted', loop: true, lines: ['const start = {K};', 'do {', '  await delay(20);', '} while ({X} > {K} - start);'] },
  { key: 'loop-alias', loop: true, lines: ['const deadline = {K} + {X};', 'const until = deadline;', 'do {', '  await delay(20);', '} while (until > {K});'] },
  { key: 'loop-elapsed-name', loop: true, lines: ['const start = {K};', 'for (;;) {', '  const elapsed = {K} - start;', '  if (elapsed > {X}) break;', '  await sleep(10);', '}'] },
  { key: 'loop-flag', loop: true, lines: ['const start = {K};', 'while (true) {', '  const timedOut = {K} - start > {X};', '  if (timedOut) break;', '  await sleep(10);', '}'] },
  { key: 'loop-and', loop: true, lines: ['const deadline = {K} + {X};', 'while (!ready() && {K} < deadline) await sleep(10);'] },
  { key: 'loop-counter', loop: true, lines: ['for (let attempt = 0; attempt < {X}; attempt += 1) {', '  if (ready()) break;', '  await sleep(100);', '}'] },
  { key: 'loop-counter-interval', loop: true, lines: ['for (let i = 0; i < 20; i++) {', '  await sleep({X});', '}'] },
  { key: 'loop-none', loop: true, lines: ['while (!ready()) {', '  await sleep({X});', '}'] },
  { key: 'loop-param', loop: true, lines: ['async function poll(check: () => boolean, ms = {X}): Promise<void> {', '  const deadline = {K} + ms;', '  while (!check()) {', "    if ({K} > deadline) throw new Error('late');", '    await sleep(10);', '  }', '}'] },
  { key: 'loop-for-of', loop: true, lines: ['for (const item of items) {', '  await sleep({X});', '}'] },
  // Waits that are not awaited: returned, an arrow's body, chained with `.then`, renamed, namespaced or bracketed.
  { key: 'vi-arrow-body', lines: ['const settle = () => vi.waitFor(() => ready(), { timeout: {X} });'] },
  { key: 'vi-returned', lines: ['function settle() {', '  return vi.waitFor(() => ready(), { timeout: {X} });', '}'] },
  { key: 'vi-then', lines: ['vi.waitFor(() => ready(), { timeout: {X} }).then(done);'] },
  { key: 'vi-bracket-bare', lines: ["void vi['waitFor'](() => ready(), { timeout: {X} });"] },
  { key: 'poll-bare', lines: ['void expect.poll(() => count(), { timeout: {X} }).toBe(1);'] },
  { key: 'tl-alias-bare', lines: ['observe(() => ready(), { timeout: {X} });'], imports: ["import { waitFor as observe } from '@testing-library/react';"] },
  { key: 'tl-alias-arrow', lines: ['const settle = () => observe(() => ready(), { timeout: {X} });'], imports: ["import { waitFor as observe } from '@testing-library/react';"] },
  { key: 'tl-namespace-bracket', lines: ["void rtl['waitFor'](() => ready(), { timeout: {X} });"], imports: ["import * as rtl from '@testing-library/react';"] },
  { key: 'tl-find-then', lines: ["screen.findByText('x', {}, { timeout: {X} }).then(done);"], imports: ["import { screen } from '@testing-library/react';"] },
  { key: 'helper-bare', lines: ['void until(() => ready(), {X});'] },
  { key: 'helper-arrow-body', lines: ['const settle = () => waitFor(() => ready(), {X});'] },
  // Query names the rule reads by their `findBy`/`findAllBy` start, with no Testing Library import and no `await` in the file.
  { key: 'find-dollar-bare', lines: ["findByText$('x', {}, { timeout: {X} });"] },
  { key: 'find-accent-member', lines: ["screen.findByTexté('x', {}, { timeout: {X} }).then(done);"] },
  { key: 'find-all-accent-arrow', lines: ["const settle = () => screen.findAllByRoleÄ('row', {}, { timeout: {X} });"] },
  { key: 'find-plain-bare', lines: ["void screen.findAllByRole('row', {}, { timeout: {X} });"] },
];

/** The waits crossed with every value and every source. */
export const FULL_WAITS = ['sleep', 'promise-arrow', 'vi-number', 'vi-options', 'helper-number', 'tl-options', 'helper-default', 'loop-deadline', 'loop-elapsed-head', 'loop-counter', 'loop-counter-interval'];

/** A `// bound:` comment, placed around the wait's first line. */
interface Comment {
  key: string;
  above?: string[];
  trailing?: string;
}

export const COMMENTS: Comment[] = [
  { key: 'none' },
  { key: 'trailing', trailing: ' // bound: a fixture that sleeps on purpose' },
  { key: 'above', above: ['// bound: a fixture that sleeps on purpose'] },
  { key: 'above-block', above: ['// bound: a fixture that sleeps on purpose', '// and a second line of the reason'] },
  { key: 'above-far', above: ['// bound: a fixture that sleeps on purpose', '', '// an unrelated note'] },
  { key: 'empty-reason', trailing: ' // bound:' },
  { key: 'block-comment', above: ['/* bound: a fixture that sleeps on purpose */'] },
  { key: 'jsdoc-above', above: ['/** bound: a fixture that sleeps on purpose */'] },
  { key: 'reason-after-code', above: ["const note = 'x'; // bound: a fixture that sleeps on purpose"] },
  { key: 'uppercase', trailing: ' // Bound: a fixture that sleeps on purpose' },
];

/** The function a wait sits in. */
interface Wrapper {
  key: string;
  wrap: (body: string[]) => string[];
}

export const WRAPPERS: Wrapper[] = [
  { key: 'it', wrap: body => ["it('waits', async () => {", ...indent(body), '});'] },
  { key: 'module', wrap: body => body },
  { key: 'function', wrap: body => ['export async function settle(): Promise<void> {', ...indent(body), '}'] },
  { key: 'method', wrap: body => ['class Harness {', '  async settle(): Promise<void> {', ...indent(body, '    '), '  }', '}'] },
  { key: 'nested-arrow', wrap: body => ["describe('suite', () => {", "  it('waits', async () => {", '    await act(async () => {', ...indent(body, '      '), '    });', '  });', '});'] },
  { key: 'loop-callback', wrap: body => ['for (const row of rows) {', "  it(row.id, async () => {", ...indent(body, '    '), '  });', '}'] },
  { key: 'static-block', wrap: body => ['class Fixture {', '  static {', '    void (async () => {', ...indent(body, '      '), '    })();', '  }', '}'] },
];

const fill = (text: string, x: string, k: string): string => text.replaceAll('{X}', x).replaceAll('{K}', k);

/** One cell's code: imports, module lines, the wrapped wait with its comment, then module lines that follow. */
export function cellCode(wait: Wait, source: Source, value: Value, clock: string, comment: Comment, wrapper: Wrapper): string {
  const v = (line: string): string => line.replaceAll('{V}', value.text);
  const x = source.ref.replaceAll('{V}', value.text);
  const [first = '', ...rest] = wait.lines.map(line => fill(line, x, CLOCKS[clock] ?? 'Date.now()'));
  const waitLines = [...(comment.above ?? []), first + (comment.trailing ?? ''), ...rest];
  const body = [...(source.localBefore ?? []).map(v), ...waitLines, ...(source.localAfter ?? []).map(v)];
  const wrapped = source.wrap ? source.wrap(body).map(v) : wrapper.wrap(body);
  const imports = [...new Set([...(wait.imports ?? []), ...(source.imports ?? [])])];
  return [
    ...imports,
    ...(imports.length > 0 ? [''] : []),
    ...(source.moduleBefore ?? []).map(v),
    ...wrapped,
    ...(source.moduleAfter ?? []).map(v),
    '',
  ].join('\n');
}

const by = <T extends { key: string }>(list: T[], keys: string[]): T[] => keys.map(key => {
  const found = list.find(each => each.key === key);
  if (!found) throw new Error(`no matrix entry ${key}`);
  return found;
});

/** The cells of one profile, in tiers: the full cross first, then the axes crossed with a few of the others. */
export function profileCells(profile: Profile, tiers: { full: boolean }): Cell[] {
  const cells: Cell[] = [];
  const values = VALUES.filter(value => !(profile.tsx && value.angle));
  const few = by(values, FEW_VALUES.filter(key => values.some(value => value.key === key)));
  const fewSources = by(SOURCES, FEW_SOURCES);
  const [none] = COMMENTS;
  const [it] = WRAPPERS;
  const add = (tier: string, wait: Wait, source: Source, value: Value, clock: string, comment = none!, wrapper = it!): void => {
    const id = [tier, profile.key, wait.key, source.key, value.key, wait.loop ? clock : '-', comment.key, wrapper.key].join('/');
    cells.push({ id, file: profile.file, code: cellCode(wait, source, value, clock, comment, wrapper) });
  };
  crossWaits(add, values, few, fewSources, tiers.full);
  crossAxes(add, values, few, fewSources);
  return cells;
}

type Add = (tier: string, wait: Wait, source: Source, value: Value, clock: string, comment?: Comment, wrapper?: Wrapper) => void;

/** The full cross of the main waits, then every other wait with a few values and sources, then the sources with fixed values. */
function crossWaits(add: Add, values: Value[], few: Value[], fewSources: Source[], full: boolean): void {
  const rest = WAITS.filter(wait => !FULL_WAITS.includes(wait.key));
  if (full) for (const wait of by(WAITS, FULL_WAITS)) for (const source of SOURCES) for (const value of values) add('full', wait, source, value, 'date');
  for (const wait of full ? rest : WAITS) for (const source of fewSources) for (const value of few) add('few', wait, source, value, 'date');
  for (const wait of WAITS) for (const source of FIXED_SOURCES) add('fixed', wait, source, values[0]!, 'date');
}

/** The other clocks for each loop, then each comment and each wrapper for every wait. */
function crossAxes(add: Add, values: Value[], few: Value[], fewSources: Source[]): void {
  const clocks = Object.keys(CLOCKS).filter(key => key !== 'date');
  for (const wait of WAITS.filter(each => each.loop)) for (const clock of clocks) for (const source of fewSources) for (const value of few) add('clock', wait, source, value, clock);
  const commentValues = by(values, ['lit-500', 'lit-15000']);
  const [inline] = by(SOURCES, ['inline']);
  const [local] = by(SOURCES, ['local-const']);
  for (const comment of COMMENTS.slice(1)) for (const wait of WAITS) for (const value of commentValues) add('comment', wait, inline!, value, 'date', comment);
  for (const wrapper of WRAPPERS.slice(1)) for (const wait of WAITS) for (const value of commentValues) add('wrapper', wait, inline!, value, 'date', COMMENTS[0], wrapper);
  for (const wrapper of WRAPPERS.slice(1)) for (const wait of WAITS) add('wrapper', wait, local!, commentValues[0]!, 'date', COMMENTS[0], wrapper);
}

const PLANS: Record<string, [Profile, boolean]> = {
  server: [PROFILES.server, true],
  serverkit: [PROFILES.serverkit, false],
  cockpit: [PROFILES.cockpit, true],
  cockpitts: [PROFILES.cockpitts, false],
};

/** One profile's cells, by oracle entry: the server and cockpit profiles in full, their second file type with the reduced cross. */
export function matrixProfile(name: string): Cell[] {
  const plan = PLANS[name];
  if (!plan) throw new Error(`no matrix profile ${name}`);
  return profileCells(plan[0], { full: plan[1] });
}

/** Every cell, by oracle entry. */
export const matrixCells = (): Record<string, Cell[]> => Object.fromEntries(Object.keys(PLANS).map(name => [name, matrixProfile(name)]));
