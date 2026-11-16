import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RUNNER_IDS } from '../core/agent-runner.ts';
import {
  declaredRunnerIds, readRunnerIdBranchExceptions, runnerIdBranch, runnerIdBranches, runnerIdBranchesFile, scanRunnerIdBranches,
  staleRunnerIdBranches,
} from './runner-id-branch.ts';

const file = 'packages/cezar/src/server/pick.ts';
const sites = (source: string, path = file) => runnerIdBranches(path, source).map(({ site }) => site);
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('runner-id-branch (hearsay-tools/cezarion#2991)', () => {
  it('reads the ids the runner module declares', () => {
    expect(declaredRunnerIds()).toEqual([...RUNNER_IDS]);
    expect(() => declaredRunnerIds(() => 'export const RUNNER_IDS = build();')).toThrow('RUNNER_IDS is not a string array literal');
    expect(() => declaredRunnerIds(() => "export const RUNNER_IDS = ['a', other] as const;")).toThrow('RUNNER_IDS is not a string array literal');
  });

  it.each([...RUNNER_IDS, 'claude-cli'])('refuses a comparison and a case label with %s', (id) => {
    expect(sites(`if (runner === '${id}') go();`)).toEqual([`runner === '${id}'`]);
    expect(sites(`switch (runner) { case '${id}': go(); }`)).toEqual([`switch (runner) case '${id}'`]);
  });

  it.each([
    ["backend !== 'omp'", "backend !== 'omp'"],
    ["run.runner == 'pi'", "run.runner == 'pi'"],
    ["step?.backend != 'codex'", "step?.backend != 'codex'"],
    ["'opencode' === runner", "runner === 'opencode'"],
    ["runner === ('opencode' as const)", "runner === 'opencode'"],
    ["runner === ('opencode' satisfies string)", "runner === 'opencode'"],
    ['runner === `opencode`', "runner === 'opencode'"],
    ['runner === "opencode"', "runner === 'opencode'"],
    ["config\n  .defaultRunner === 'claude'", "config .defaultRunner === 'claude'"],
    ["switch (runner) { case 'codex': case 'gh': break; case 'pi': break; default: }", "switch (runner) case 'codex', 'pi'"],
    ["const f = (a: string) => a === 'opencode' || a === 'omp'", "a === 'opencode'|a === 'omp'"],
  ])('refuses %s', (source, expected) => {
    expect(sites(source)).toEqual(expected.split('|'));
  });

  it('reads JSX in a .tsx file', () => {
    expect(sites("const a = <p>{runner === 'opencode' ? 'a' : 'b'}</p>;", 'packages/web/src/routes/pick.tsx')).toEqual(["runner === 'opencode'"]);
  });

  it.each([
    "message.t === 'opencode'",
    "switch (message.t) { case 'opencode': break; }",
    "switch (event.type) { case 'pi': break; }",
    "type !== 'codex'",
    "'pi' === 'pi'",
    'runner === other',
    "runner === 'gh'",
    "ids.includes('opencode')",
    "const labels = { opencode: 'OpenCode' }; labels['pi'];",
    "// runner === 'opencode'",
    "const text = \"runner === 'opencode'\";",
    "type Only = Extract<Runner, 'opencode'>;",
  ])('passes %s', (source) => {
    expect(sites(source)).toEqual([]);
  });

  it('refuses malformed source that names an id, and skips source that names none', () => {
    expect(() => sites("runner === 'pi'; let x = ;")).toThrow();
    expect(sites('let x = ;')).toEqual([]);
  });

  it.each([
    ['packages/cezar/src/server/server.ts', true],
    ['packages/web/src/routes/new-task-form.ts', true],
    ['packages/web/src/routes/settings/dialog.tsx', true],
    ['packages/cezar/src/core/runner-factory.ts', false],
    ['packages/cezar/src/server/server.test.ts', false],
    ['packages/cezar/src/workflows/cells.testkit.ts', false],
    ['packages/web/src/test/render.tsx', false],
    ['packages/web/e2e/new-task.e2e.ts', false],
    ['packages/contract/src/health.ts', false],
    ['packages/cezar/scripts/mock-pi.mjs', false],
  ])('scopes %s', (path, expected) => {
    expect(runnerIdBranch.applies(path)).toBe(expected);
  });

  it('lets a listed site pass up to its count, in its own file only', () => {
    const source = "if (runner === 'opencode') a();\nif (runner === 'opencode') b();\nif (runner === 'omp') c();\n";
    const exceptions = [{ file, site: "runner === 'opencode'", count: 1, reason: 'identity choice: a fixture' }];
    expect(scanRunnerIdBranches(file, source, exceptions).map(({ site }) => site)).toEqual(["runner === 'opencode'", "runner === 'omp'"]);
    expect(scanRunnerIdBranches('packages/cezar/src/server/other.ts', source, exceptions)).toHaveLength(3);
    expect(runnerIdBranch.check(file, "\nif (runner === 'opencode') a();")).toEqual([
      { line: 2, message: expect.stringMatching(/^runner === 'opencode': only packages\/cezar\/src\/core\/ branches on a runner id\..+RUNNER_FACTS.+hearsay-tools\/cezarion#2991/) },
    ]);
  });

  it('gives every listed site one of the two reasons, once', () => {
    const entries = readRunnerIdBranchExceptions();
    for (const entry of entries) {
      expect(entry.reason, `${entry.file}: ${entry.site}`).toMatch(/^(?:identity choice|capability branch; should become a fact): \S/);
      expect(runnerIdBranch.applies(entry.file), entry.file).toBe(true);
    }
    expect(new Set(entries.map(entry => `${entry.file}\n${entry.site}`)).size).toBe(entries.length);
  });

  it('names an entry that is stale, repeated, unreasoned or out of scope', () => {
    const root = mkdtempSync(join(tmpdir(), 'cez-runner-branches-'));
    roots.push(root);
    const write = (path: string, text: string) => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    };
    const core = 'packages/cezar/src/core/pick.ts';
    write(file, "if (runner === 'opencode') a();\nif (backend === 'omp') b();\nif (backend === 'omp') c();\nif (id === 'pi') d();\n");
    write(core, "if (runner === 'opencode') a();\n");
    const entry = (site: string, count: number, reason = 'identity choice: a fixture', path = file) => ({ file: path, site, count, reason });
    write(runnerIdBranchesFile, JSON.stringify({ entries: [
      entry("runner === 'opencode'", 1),
      entry("backend === 'omp'", 3),
      entry("runner === 'opencode'", 1),
      entry("id === 'pi'", 1, ' '),
      entry("runner === 'opencode'", 1, undefined, core),
      entry("runner === 'codex'", 1, undefined, 'packages/cezar/src/server/gone.ts'),
    ] }));
    const stale = (path: string, site: string, lists: number, has: number) =>
      `${runnerIdBranchesFile} cez/runner-id-branch: stale or invalid entry ${path}: ${site} (lists ${lists}, the file has ${has}); lower the count or remove the entry`;
    expect(staleRunnerIdBranches(root)).toEqual([
      stale(file, "backend === 'omp'", 3, 2),
      stale(file, "runner === 'opencode'", 1, 1),
      stale(file, "id === 'pi'", 1, 1),
      stale(core, "runner === 'opencode'", 1, 1),
      stale('packages/cezar/src/server/gone.ts', "runner === 'codex'", 1, 0),
    ]);
  });
});
