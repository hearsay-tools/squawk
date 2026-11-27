import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { PATH_PIN_DIRS, RUNNER_ID_READERS, TREES, groupByTree, parseArgs, runnerReaders, searchName, searchPins, specifierOf, sweep } from './readers.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(repoRoot, 'scripts/readers.mjs');

function fixtureRepo(t, files) {
  const root = mkdtempSync(join(tmpdir(), 'cez-readers-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  execFileSync('git', ['init', '-q', root]);
  return root;
}

test('a sweep for a name lists a fixture reader in every tree it searches', (t) => {
  const files = Object.fromEntries(TREES.map(tree => [`${tree}/reader.ts`, 'startServer({ port });\n']));
  files['other/deep/reader.md'] = 'Calls startServer.\n';
  files['packages/web/e2e/not-a-reader.ts'] = 'start();\n';
  const root = fixtureRepo(t, files);

  const result = searchName(root, 'startServer');
  const groups = groupByTree(result.hits);
  for (const tree of TREES) assert.deepEqual(groups.get(tree)?.map(hit => hit.file), [`${tree}/reader.ts`], tree);
  assert.deepEqual(groups.get('other')?.map(hit => hit.file), ['other/deep/reader.md']);
});

test('a sweep finds an untracked reader and skips an ignored one', (t) => {
  const root = fixtureRepo(t, { '.gitignore': 'build/\n', 'scripts/new.mjs': 'removedExport();\n', 'build/out.js': 'removedExport();\n' });
  assert.deepEqual(searchName(root, 'removedExport').hits.map(hit => hit.file), ['scripts/new.mjs']);
});

test('a sweep for a path also lists readers that import it through a relative specifier', (t) => {
  const root = fixtureRepo(t, {
    'packages/cezar/scripts/mock-scenario.mjs': 'export const scenario = 1;\n',
    'packages/cezar/src/core/mock.test.ts': "import { scenario } from '../../scripts/mock-scenario.mjs';\n",
    'packages/cezar/src/home/mobile.test.ts': "import '../../../mobile/scripts/build-metadata.mjs';\n",
    'docs/runners.md': 'See packages/cezar/scripts/mock-scenario.mjs.\n',
  });

  const scenario = searchName(root, 'packages/cezar/scripts/mock-scenario.mjs');
  assert.equal(scenario.specifier, '/mock-scenario');
  assert.deepEqual(scenario.hits.map(hit => [hit.file, hit.form]), [['docs/runners.md', 'exact'], ['packages/cezar/src/core/mock.test.ts', 'specifier']]);

  const mobile = searchName(root, 'packages/mobile');
  assert.deepEqual(mobile.hits.map(hit => [hit.file, hit.form]), [['packages/cezar/src/home/mobile.test.ts', 'specifier']]);
});

test('only a path name has a relative-specifier form', () => {
  assert.equal(specifierOf('startServer'), undefined);
  assert.equal(specifierOf('packages/mobile/'), '/mobile');
  assert.equal(specifierOf('runs/legacy-run-rows.ts'), '/legacy-run-rows');
});

test('a runner sweep lists every saved-run reader and the quoted id', (t) => {
  const files = Object.fromEntries(RUNNER_ID_READERS.map(entry => [entry.file, `${entry.anchor}\n`]));
  files['packages/cezar/src/core/agent-runner.ts'] = "export const RUNNER_IDS = ['claude', 'retired'];\n";
  files['packages/cezar/src/preview/cursor.ts'] = 'const retired = 1;\n';
  const root = fixtureRepo(t, files);

  const { report, code } = sweep(root, { names: [], runner: 'retired' });
  assert.equal(code, 0);
  for (const entry of RUNNER_ID_READERS) assert.match(report, new RegExp(`^ok +${entry.file.replaceAll('.', '\\.')} `, 'm'));
  assert.match(report, /packages\/cezar\/src\/core\/agent-runner\.ts:1:/);
  assert.doesNotMatch(report, /preview\/cursor\.ts/);
});

test('a runner sweep exits 1 when a listed reader no longer holds its anchor', (t) => {
  const root = fixtureRepo(t, { [RUNNER_ID_READERS[0].file]: 'moved away\n' });
  const { report, code } = sweep(root, { names: [], runner: 'retired' });
  assert.equal(code, 1);
  assert.match(report, new RegExp(`^MISSING ${RUNNER_ID_READERS[0].file.replaceAll('.', '\\.')} `, 'm'));
});

test('every listed runner-id reader still holds its anchor in this checkout', () => {
  assert.deepEqual(runnerReaders(repoRoot).filter(entry => !entry.found).map(entry => entry.file), []);
});

test('AGENT_PROTOCOL.md § Removing a runner names exactly the listed readers', () => {
  const protocol = readFileSync(join(repoRoot, 'AGENT_PROTOCOL.md'), 'utf8');
  const section = /^## 10a\. Removing a runner\n([\s\S]*?)^## /m.exec(protocol)?.[1];
  assert.ok(section, 'AGENT_PROTOCOL.md has a "## 10a. Removing a runner" section');
  const named = new Set([...section.matchAll(/`((?:packages)\/[^`]+\.tsx?)`/g)].map(match => match[1]));
  assert.deepEqual([...named].sort(), [...new Set(RUNNER_ID_READERS.map(entry => entry.file))].sort());
});

test('the command rejects a call without names and reports from the repository root', (t) => {
  assert.throws(() => parseArgs([]), /Usage/);
  assert.throws(() => parseArgs(['--runner']), /runner id/);
  assert.throws(() => parseArgs(['--names']), /Unknown option/);
  assert.deepEqual(parseArgs(['--runner', 'retired', '--', '--force', '-x']), { names: ['--force', '-x'], runner: 'retired' });

  const root = fixtureRepo(t, { 'packages/web/scripts/fixture-server.mjs': 'new ProjectContexts();\n' });
  mkdirSync(join(root, 'packages/cezar/src'), { recursive: true });
  const run = spawnSync(process.execPath, [script, 'ProjectContexts'], { cwd: join(root, 'packages/cezar/src'), encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^packages\/web\/scripts: 1$/m);
  assert.match(run.stdout, /^ {2}packages\/web\/scripts\/fixture-server\.mjs:1: new ProjectContexts\(\);$/m);
  assert.equal(spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8' }).status, 2);
});

test('a sweep reads Git output the same under a colouring config and a file name with a colon', (t) => {
  const root = fixtureRepo(t, { 'scripts/a:1:b.mjs': 'removedExport();\n' });
  const env = { ...process.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'color.grep', GIT_CONFIG_VALUE_0: 'always' };
  const run = spawnSync(process.execPath, [script, 'removedExport'], { cwd: root, env, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^ {2}scripts\/a:1:b\.mjs:1: removedExport\(\);$/m);
});

test('a moved-file sweep lists every JSON pin that names the old path, and its readers', (t) => {
  const old = 'packages/contract/src/waits.ts';
  const root = fixtureRepo(t, {
    '.github/mutants/targets.json': JSON.stringify({ [old]: { tier: 'logic', guards: ['computeWaitingOn'] } }, null, 2),
    [`.github/mutants/equivalent/${old}.json`]: JSON.stringify([{ function: 'workersOwed' }], null, 2),
    'packages/cezar/src/lint/home-readers.baseline.json': JSON.stringify({ files: { [old]: 2 } }, null, 2),
    'packages/cezar/src/lint/layer-import.baseline.json': JSON.stringify({ entries: [{ file: 'packages/cezar/src/a.ts', target: old, count: 1 }] }, null, 2),
    'packages/cezar/src/lint/resume-time-readers.json': JSON.stringify({ files: { [old]: 'reads the time' } }, null, 2),
    'packages/cezar/src/lint/other.json': JSON.stringify({ files: { 'packages/contract/src/runs.ts': 'x' } }),
    'packages/cezar/src/reader.ts': "import { computeWaitingOn } from '../../contract/src/waits';\n",
  });
  assert.deepEqual([...new Set(searchPins(root, old).map(hit => hit.file))].sort(), [
    '.github/mutants/equivalent/packages/contract/src/waits.ts.json',
    '.github/mutants/targets.json',
    'packages/cezar/src/lint/home-readers.baseline.json',
    'packages/cezar/src/lint/layer-import.baseline.json',
    'packages/cezar/src/lint/resume-time-readers.json',
  ]);
  const options = parseArgs(['--moved', old, 'packages/contract/src/waiting-on.ts']);
  assert.deepEqual(options.moved, { from: old, to: 'packages/contract/src/waiting-on.ts' });
  const { report, code } = sweep(root, options);
  assert.equal(code, 0);
  assert.match(report, /## JSON pins that name packages\/contract\/src\/waits\.ts: 5 lines in 5 files; rewrite each to packages\/contract\/src\/waiting-on\.ts/);
  assert.match(report, /^ {2}\.github\/mutants\/equivalent\/packages\/contract\/src\/waits\.ts\.json: the record path names packages\/contract\/src\/waits\.ts; rename it to \.github\/mutants\/equivalent\/packages\/contract\/src\/waiting-on\.ts\.json$/m);
  assert.match(report, /packages\/cezar\/src\/reader\.ts:1 \[specifier\]/);
  assert.throws(() => parseArgs(['--moved', old]), /--moved needs <old-path> <new-path>/);
});

test('a moved-file sweep lists the per-file records of every path-pin directory, and no record of another file', (t) => {
  const old = 'packages/cezar/src/server/repo-branches.ts';
  const records = PATH_PIN_DIRS.map(dir => `${dir}/${old}.json`);
  const root = fixtureRepo(t, {
    ...Object.fromEntries(records.map(file => [file, '[]\n'])),
    [`.github/mutants/equivalent/${old}x.json`]: '[]\n',
    [`.github/mutants/equivalent/packages/cezar/src/server/repo-branches.test.ts.json`]: '[]\n',
    [`.github/mutants/equivalent/${old}.json.bak`]: '[]\n',
  });
  execFileSync('git', ['add', records[0]], { cwd: root });
  assert.deepEqual(searchPins(root, old).map(hit => hit.file).sort(), [...records].sort());
});

test('a moved-file sweep finds a pin that names the file below a shared directory', (t) => {
  const old = 'packages/web/src/routes/task-git/task-files.tsx';
  const root = fixtureRepo(t, {
    'packages/web/src/test/search-params-discipline.baseline.json': JSON.stringify({ sites: [{ file: 'routes/task-git/task-files.tsx' }] }, null, 2),
    'packages/web/src/test/card-2-contrast.baseline.json': JSON.stringify(['task-git/task-files.tsx: <Button>'], null, 2),
    'packages/web/src/test/other.baseline.json': JSON.stringify(['task-files.tsx']),
  });
  assert.deepEqual([...new Set(searchPins(root, old).map(hit => hit.file))].sort(), [
    'packages/web/src/test/card-2-contrast.baseline.json',
    'packages/web/src/test/search-params-discipline.baseline.json',
  ]);
});
