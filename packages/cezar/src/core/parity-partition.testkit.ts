import { BUILT_IN_RUNNER_IDS } from '../runners/ids.ts';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { runsOn, type ParityFamilyName } from './parity-classes.testkit.ts';
import { registrationStrings } from './registration-coverage.testkit.ts';

type Cell = { name: string; body: CellBody; timeout: number | undefined };
export type CellBody = () => void | Promise<void>;
export type ParityPart = string;
export type ParityCollector = (name: string) => void;

/** The body of a cell a registration guard only collects by name; it never runs. */
export function collectedOnly(): CellBody {
  return () => { throw new Error('a collected parity cell never runs'); };
}

/** Stable cell identity, including the autonomous constructor variants. */
export function parityCellKey(name: string): string {
  const pair = /^(\w+) ([A-Z]\d+)\b/.exec(name);
  if (!pair) return name;
  const mode = /\((fresh|continuation)\)$/.exec(name);
  return `${pair[1]} ${pair[2]}${mode ? ` ${mode[1]}` : ''}`;
}

/** Whether a `<runner> <row> …` cell runs on its runner under the family's class (hearsay-tools/cezarion#2991). */
function familyRuns(family: ParityFamilyName | undefined, name: string): boolean {
  const pair = /^(\w+) ([A-Z]\d+)\b/.exec(name);
  if (!family || !pair || !(BUILT_IN_RUNNER_IDS as readonly string[]).includes(pair[1]!)) return true;
  return runsOn(family, pair[2], pair[1] as string);
}

/** The cell's name without its leading runner id: `R92` for `claude R92`. */
const afterRunner = (key: string): string => key.slice(key.indexOf(' ') + 1);

/**
 * Whether `part` runs the cell `key`. A part lists the cells of the runners that shipped, because
 * the parts split a family's cells across files. A cell of a runner that no part names by row follows
 * the first part that lists the same row for another runner, so a new runner adds no entry here; a cell
 * of a listed runner that no part lists still belongs to no part, and the registration guard fails.
 */
function inPart(part: ParityPart, parts: Readonly<Record<string, readonly string[]>>, key: string): boolean {
  if (parts[part]?.includes(key)) return true;
  const runner = key.slice(0, key.indexOf(' '));
  if (!(BUILT_IN_RUNNER_IDS as readonly string[]).includes(runner)) return false;
  const named = Object.values(parts).some(entries => entries.some(entry => entry.startsWith(`${runner} `) && /^\w+ [A-Z]\d+\b/.test(entry)));
  if (named) return false;
  const first = Object.entries(parts).find(([, entries]) => entries.some(entry => afterRunner(entry) === afterRunner(key)));
  return first?.[0] === part;
}

/** Collect before opening a suite: a part must not register empty describes. A `family` drops each
 *  cell whose row does not run on its runner, before the part is chosen. */
export function partitionParity(part: ParityPart, parts: Readonly<Record<string, readonly string[]>>, collect?: ParityCollector, family?: ParityFamilyName) {
  let cells: Cell[] = [];
  return {
    it(name: string, body: CellBody, timeout?: number): void {
      if (!familyRuns(family, name)) return;
      if (part === 'all' || inPart(part, parts, parityCellKey(name))) cells.push({ name, body, timeout });
    },
    describe(name: string, body: () => void): void {
      cells = [];
      body();
      const selected = cells;
      if (collect) selected.forEach(cell => collect(cell.name));
      else if (selected.length) describe(name, () => {
        for (const cell of selected) it(cell.name, cell.body, cell.timeout);
      });
    },
  };
}

/** A cell's kind: its stable identity with a leading runner id replaced, `<runner> R92` for `claude R92`.
 *  A cell that no runner owns is its own kind. */
function cellKind(name: string): string {
  const key = parityCellKey(name);
  const runner = key.slice(0, key.indexOf(' '));
  return (BUILT_IN_RUNNER_IDS as readonly string[]).includes(runner) ? `<runner> ${afterRunner(key)}` : key;
}

/** Read the actual entrypoints, then compare their registrations with the unsplit suite. */
export function checkParityRegistration(
  family: string,
  register: (part: ParityPart, collect?: ParityCollector) => void,
  pairs: readonly string[],
  count: number,
  directory = new URL('.', import.meta.url),
): void {
  const expected: string[] = [];
  register('all', name => expected.push(name));
  // `count` pins the kinds of cell, not their copies per runner: a new runner adds copies of the
  // kinds that exist, so it changes no count, while a lost shared cell or constructor variant does.
  expect(new Set(expected.map(cellKind)).size).toBe(count);
  const registeredPairs = expected.flatMap(name => {
    const pair = /^(\w+) ([A-Z]\d+)\b/.exec(name);
    return pair ? [`${pair[1]} ${pair[2]}`] : [];
  });
  expect([...new Set(registeredPairs)].sort()).toEqual([...pairs].sort());
  const actual: string[] = [];
  const entries = readdirSync(directory).filter(file => file.endsWith('.test.ts') && !file.endsWith('-registration-parity.test.ts'))
    .map(file => {
      const source = readFileSync(new URL(file, directory), 'utf8');
      let imported = false;
      const calls = registrationStrings(source, file, register.name, `./${family}.testkit.ts`, () => { imported = true; });
      return { file, source, calls, imported };
    })
    .filter(entry => entry.imported || entry.calls.length > 0);
  expect(entries.length, family).toBeGreaterThan(1);
  for (const { file, source, calls } of entries) {
    expect(calls, file).toHaveLength(1);
    const names: string[] = [];
    register(calls[0]!, name => names.push(name));
    if (!names.length) throw new Error(`${file}: empty ${register.name} registration: ${source}`);
    actual.push(...names);
  }
  expect(new Set(expected).size).toBe(expected.length);
  expect(actual.sort()).toEqual(expected.sort());
}
