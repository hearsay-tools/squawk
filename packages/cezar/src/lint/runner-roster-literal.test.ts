import { BUILT_IN_RUNNER_IDS } from '../runners/built-in.ts';
import { checkRule } from './ast-rule.testkit.ts';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  readRunnerRosterExceptions, runnerRosterLiteral, runnerRosters, runnerRostersFile, scanRunnerRosters, staleRunnerRosters,
} from './runner-roster-literal.ts';

const file = 'packages/web/src/lib/providers.ts';
const quoted = (ids: readonly string[]) => ids.map(id => `'${id}'`).join(', ');
const ALL = quoted(BUILT_IN_RUNNER_IDS);
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('runner-roster-literal (open-mercato/cezar#387)', () => {
  it.each([
    ['a constant', `const PROVIDERS = [${ALL}];`],
    ['a const tuple', `const PROVIDERS = [${ALL}] as const;`],
    ['another order', `const PROVIDERS = [${quoted([...BUILT_IN_RUNNER_IDS].reverse())}];`],
    ['a roster with more names', `const TOOLS = [${ALL}, 'gh', 'git'];`],
    ['a schema', `const schema = z.enum([${ALL}]);`],
    ['a set', `const ids = new Set<string>([${ALL}]);`],
    ['one id per line', `const PROVIDERS = [\n  ${BUILT_IN_RUNNER_IDS.map(id => `'${id}'`).join(',\n  ')},\n];`],
    ['cast and template elements', `const PROVIDERS = [${BUILT_IN_RUNNER_IDS.map((id, index) => (index % 2 ? `\`${id}\`` : `'${id}' as const`)).join(', ')}];`],
    ['a test oracle', `expect(tabs()).toEqual([${ALL}]);`],
  ])('refuses %s', (_case, source) => {
    expect(runnerRosters(file, `\n${source}`)).toHaveLength(1);
    expect(checkRule(runnerRosterLiteral, file, `\n${source}`)).toEqual([
      { line: 2, message: expect.stringMatching(/Use BUILT_IN_RUNNERS or BUILT_IN_RUNNER_IDS from packages\/cezar\/src\/runners\/built-in\.ts.+GET \/api\/v1\/runners.+open-mercato\/cezar#387/) },
    ]);
  });

  it.each([
    ['a list that omits a runner', `const SOME = [${quoted(BUILT_IN_RUNNER_IDS.slice(1))}];`],
    ['a list derived from the roster', "const STORED = [...BUILT_IN_RUNNER_IDS, 'claude-cli'];"],
    ['object keys', `const LABELS = { ${BUILT_IN_RUNNER_IDS.map(id => `${id}: ''`).join(', ')} };`],
    ['a union type', `type Runner = ${BUILT_IN_RUNNER_IDS.map(id => `'${id}'`).join(' | ')};`],
    ['a string', `const text = "[${ALL}]";`],
    ['a comment', `// [${ALL}]`],
    ['separate arguments', `pick(${ALL});`],
  ])('passes %s', (_case, source) => {
    expect(runnerRosters(file, source)).toEqual([]);
    expect(checkRule(runnerRosterLiteral, file, source)).toEqual([]);
  });

  it('reads JSX, plain JavaScript and refuses malformed source that names every id', () => {
    expect(runnerRosters('packages/web/src/routes/tabs.tsx', `const tabs = <Tabs ids={[${ALL}]} />;`)).toHaveLength(1);
    expect(runnerRosters('packages/cezar/scripts/mock-all.mjs', `export const all = [${ALL}];`)).toHaveLength(1);
    expect(() => runnerRosters(file, `const a = [${ALL}]; let x = ;`)).toThrow();
    expect(runnerRosters(file, 'let x = ;')).toEqual([]);
  });

  it.each([
    ['packages/cezar/src/runners/built-in.ts', false],
    ['packages/cezar/src/core/provider-auth.ts', true],
    ['packages/cezar/src/core/ui-parity.test.ts', true],
    ['packages/web/e2e/tools-menu.e2e.ts', true],
    ['packages/web/src/routes/settings/accounts-section.tsx', true],
    ['packages/cezar/scripts/mock-pi.mjs', true],
    ['packages/contract/src/health.ts', true],
    ['packages/cezar/src/lint/runner-roster-literal.baseline.json', false],
    ['scripts/dev.mjs', false],
  ])('scopes %s', (path, expected) => {
    expect(runnerRosterLiteral.applies(path)).toBe(expected);
  });

  it('lets a listed file keep its count, and no other file', () => {
    const source = `const a = [${ALL}];\nconst b = [${ALL}];\n`;
    const exceptions = [{ file, count: 1, reason: 'a fixture' }];
    expect(scanRunnerRosters(file, source, exceptions)).toEqual([source.indexOf('[', 20)]);
    expect(scanRunnerRosters('packages/web/src/lib/other.ts', source, exceptions)).toHaveLength(2);
  });

  it('gives every listed file a reason, once', () => {
    const entries = readRunnerRosterExceptions();
    for (const entry of entries) {
      expect(entry.reason.trim(), entry.file).not.toBe('');
      expect(runnerRosterLiteral.applies(entry.file), entry.file).toBe(true);
    }
    expect(new Set(entries.map(entry => entry.file)).size).toBe(entries.length);
  });

  // A runner id is an open string in the contract (spec 2026-11-18-runner-definitions), so no file
  // keeps a roster.
  it('lists no file that keeps a roster', () => {
    expect(readRunnerRosterExceptions()).toEqual([]);
  });

  it('names an entry that is stale, repeated, unreasoned or out of scope', () => {
    const root = mkdtempSync(join(tmpdir(), 'cez-runner-rosters-'));
    roots.push(root);
    const write = (path: string, text: string) => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    };
    const definition = 'packages/cezar/src/runners/built-in.ts';
    const derived = 'packages/web/src/lib/derived.ts';
    const unreasoned = 'packages/web/src/lib/unreasoned.ts';
    write(file, `const a = [${ALL}];\n`);
    write(definition, `export const BUILT_IN_RUNNER_IDS = [${ALL}] as const;\n`);
    write(derived, 'const a = runnerSchema.options;\n');
    write(unreasoned, `const a = [${ALL}];\n`);
    write(runnerRostersFile, JSON.stringify({ entries: [
      { file, count: 1, reason: 'kept' },
      { file, count: 1, reason: 'repeated' },
      { file: definition, count: 1, reason: 'the definition is outside the rule' },
      { file: derived, count: 1, reason: 'derived since' },
      { file: unreasoned, count: 1, reason: '' },
      { file: 'packages/web/src/lib/gone.ts', count: 2, reason: 'deleted' },
    ] }));
    const stale = (path: string, lists: number, has: number) =>
      `${runnerRostersFile} cez/runner-roster-literal: stale or invalid entry ${path} (lists ${lists}, the file has ${has}); lower the count or remove the entry`;
    expect(staleRunnerRosters(root)).toEqual([
      stale(file, 1, 1),
      stale(definition, 1, 1),
      stale(derived, 1, 0),
      stale(unreasoned, 1, 1),
      stale('packages/web/src/lib/gone.ts', 2, 0),
    ]);
  });
});
