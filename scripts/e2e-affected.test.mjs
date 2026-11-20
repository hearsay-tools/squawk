import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  bootSpec, changedLines, classify, importSpecifiers, latestMap, main, mapProblem, parseOptions, readMap, referenceGraph, resolveLiteral, selectSpecs, stringLiterals,
} from './e2e-affected.mjs';

// hearsay-tools/cezarion#1816: npm run test:e2e:affected chooses browser specs from the spec map.

const script = fileURLToPath(new URL('./e2e-affected.mjs', import.meta.url));
const yaml = createRequire(import.meta.url)('yaml');
const COMMIT = 'a'.repeat(40);
const spec = name => `packages/web/e2e/${name}.e2e.ts`;

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-affected-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const put = (path, text = '') => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  return { dir, put };
}

const sampleMap = (overrides = {}) => ({
  version: 2, commit: COMMIT, createdAt: '2026-10-26T00:00:00.000Z',
  specs: [spec('artifact-project-links'), spec('chat-code-fence'), spec('smoke')],
  incomplete: [],
  sources: {
    'packages/web/src/routes/task-thread/markdown.tsx': [0, 1],
    'packages/web/src/lib/unused.ts': [],
    'packages/api-client/src/client.ts': [0, 1, 2],
  },
  ...overrides,
});

test('options: --plan, --map and --base are the selector’s own; everything else goes to npm run test:e2e', () => {
  assert.deepEqual(parseOptions(['--plan', '--map=m.json', '--base=abc', '-t', 'name', '--force']), {
    plan: true, map: 'm.json', base: 'abc', forward: ['-t', 'name', '--force'],
  });
  assert.throws(() => parseOptions(['--map']), /--map takes a file/);
  assert.throws(() => parseOptions(['--map=']), /--map takes a file/);
  assert.throws(() => parseOptions(['--base=']), /--base takes a Git ref/);
});

test('a map is refused when its shape is not the one the refresh writes', () => {
  assert.equal(mapProblem(sampleMap()), null);
  assert.match(mapProblem({ ...sampleMap(), version: 1 }), /version is not 2/);
  assert.match(mapProblem({ ...sampleMap(), commit: 'main' }), /commit/);
  assert.match(mapProblem({ ...sampleMap(), specs: ['smoke.e2e.ts'] }), /spec paths/);
  assert.match(mapProblem({ ...sampleMap(), incomplete: [spec('gone')] }), /incomplete/);
  assert.match(mapProblem({ ...sampleMap(), sources: { 'a.ts': [3] } }), /a\.ts/);
  assert.match(mapProblem({ ...sampleMap(), sources: null }), /no sources/);
});

test('readMap names the file it cannot use', t => {
  const { dir, put } = tempDir(t);
  put('map.json', JSON.stringify(sampleMap()));
  put('bad.json', '{');
  assert.equal(readMap(join(dir, 'map.json')).map.commit, COMMIT);
  assert.match(readMap(join(dir, 'bad.json')).error, /cannot read the spec map at .*bad\.json/);
  assert.match(readMap(join(dir, 'missing.json')).error, /cannot read/);
});

test('the newest map from main is downloaded once, and the cache answers when gh cannot', t => {
  const { dir, put } = tempDir(t);
  const calls = [];
  const gh = (runs, download = () => {}) => (command, args) => {
    calls.push([command, ...args].join(' '));
    if (args[1] === 'list') return JSON.stringify(runs);
    return download(args);
  };
  const writeArtifact = args => put(join(args[args.indexOf('--dir') + 1].slice(dir.length + 1), 'e2e-spec-map.json'), JSON.stringify(sampleMap()));
  const runs = [{ databaseId: 9, event: 'pull_request' }, { databaseId: 7, event: 'push' }];

  const first = latestMap(dir, gh(runs, writeArtifact));
  assert.equal(first.map.commit, COMMIT);
  assert.match(first.file, /\.ai\/qa\/e2e-spec-map\/7\/e2e-spec-map\.json$/);
  assert.equal(calls.filter(call => call.includes('run download 7 --name e2e-spec-map')).length, 1);

  calls.length = 0;
  assert.equal(latestMap(dir, gh(runs, () => { throw new Error('downloaded again'); })).map.commit, COMMIT);
  assert.deepEqual(calls.map(call => call.split(' ')[2]), ['list']);

  const offline = () => { throw Object.assign(new Error('failed'), { stderr: 'error connecting to api.github.com\nmore' }); };
  const warnings = [];
  t.mock.method(console, 'warn', message => warnings.push(message));
  assert.equal(latestMap(dir, offline).map.commit, COMMIT);
  assert.match(warnings[0], /error connecting to api\.github\.com\); using the map cached from run 7\./);

  const empty = tempDir(t);
  assert.match(latestMap(empty.dir, offline).error, /^no spec map: gh cannot list the e2e-spec-map\.yml runs \(error connecting/);
  assert.match(latestMap(empty.dir, gh([{ databaseId: 3, event: 'pull_request' }])).error, /no successful run on main/);
});

test('the map comes from the newest run at or before the fork point, never from a later one', t => {
  const { dir, put } = tempDir(t);
  const LATER = 'c'.repeat(40);
  const OLDER = 'd'.repeat(40);
  const usable = commit => commit !== LATER;
  const downloads = [];
  const gh = runs => (command, args) => {
    if (args[1] === 'list') return JSON.stringify(runs);
    const id = args[2];
    downloads.push(id);
    put(join(CACHE, id, 'e2e-spec-map.json'), JSON.stringify(sampleMap({ commit: id === '8' ? LATER : OLDER })));
  };
  const CACHE = '.ai/qa/e2e-spec-map';
  const runs = [{ databaseId: 8, event: 'push', headSha: LATER }, { databaseId: 6, event: 'push', headSha: OLDER }];

  const loaded = latestMap(dir, gh(runs), usable);
  assert.equal(loaded.map.commit, OLDER);
  assert.deepEqual(downloads, ['6']);

  // Offline, the cache skips a map newer than the fork point.
  put(join(CACHE, '8', 'e2e-spec-map.json'), JSON.stringify(sampleMap({ commit: LATER })));
  t.mock.method(console, 'warn', () => {});
  const offline = () => { throw new Error('offline'); };
  assert.equal(latestMap(dir, offline, usable).map.commit, OLDER);
  assert.match(latestMap(dir, offline, () => false).error, /^no spec map: gh cannot list/);
  assert.match(latestMap(tempDir(t).dir, gh([runs[0]]), usable).error,
    /^no spec map: no successful e2e-spec-map\.yml run on main maps the fork point or an earlier commit$/);
});

test('import specifiers: static, re-exported, side-effect and literal dynamic imports, never comments', () => {
  const text = [
    "import { a } from './a.ts'",
    "import type { B } from './b.ts'",
    "export { c } from '../c.mjs'",
    "import './side-effect.mjs'",
    "const d = await import('./d.ts')",
    "const e = require('./e.cjs')",
    "// import { x } from './commented.ts'",
    "const path = resolve(import.meta.dirname, 'environment.ts')",
  ].join('\n');
  assert.deepEqual(importSpecifiers(text).sort(), ['../c.mjs', './a.ts', './b.ts', './d.ts', './e.cjs', './side-effect.mjs']);
});

test('string literals: imports and spec-relative paths, never comments', () => {
  const text = [
    "import { browser } from './agent-browser' // the seam's 'helper'",
    "/* './commented.ts' */",
    "const data = resolve(import.meta.dirname, 'fixtures/run.ndjson')",
    'const url = `http://x/${id}`',
  ].join('\n');
  assert.deepEqual(stringLiterals(text), ['./agent-browser', 'fixtures/run.ndjson']);
});

test('a literal resolves to a repository file, an alias target, or a directory below the file', t => {
  const { dir, put } = tempDir(t);
  put('packages/web/e2e/poll.ts');
  put('packages/web/e2e/fixtures/run.ndjson');
  put('packages/web/e2e/fixtures/images/a.png');
  put('packages/web/src/lib/utils.ts');
  put('packages/api-client/src/contract/defined.ts');
  const from = 'packages/web/e2e/a.e2e.ts';
  assert.equal(resolveLiteral(dir, from, './poll'), 'packages/web/e2e/poll.ts');
  assert.equal(resolveLiteral(dir, from, './poll.js'), 'packages/web/e2e/poll.ts');
  assert.equal(resolveLiteral(dir, from, 'fixtures/run.ndjson'), 'packages/web/e2e/fixtures/run.ndjson');
  assert.equal(resolveLiteral(dir, from, 'fixtures/images'), 'packages/web/e2e/fixtures/images/');
  assert.equal(resolveLiteral(dir, from, '../src/lib/utils'), 'packages/web/src/lib/utils.ts');
  assert.equal(resolveLiteral(dir, from, '@open-mercato/cezar-api-client/contract/defined'), 'packages/api-client/src/contract/defined.ts');
  assert.equal(resolveLiteral(dir, 'packages/web/src/app.tsx', '@/lib/utils'), 'packages/web/src/lib/utils.ts');
  // A directory above the file, such as the repository root, is not something it reads.
  assert.equal(resolveLiteral(dir, from, '../../..'), null);
  assert.equal(resolveLiteral(dir, from, '../src'), null);
  assert.equal(resolveLiteral(dir, from, 'node:fs'), null);
  assert.equal(resolveLiteral(dir, from, 'a few words'), null);
});

test('the reference graph splits what the suite setup loads from what each spec loads', t => {
  const { dir, put } = tempDir(t);
  put('packages/web/e2e/vitest.config.ts', "import S from '../../../.github/scripts/seq.mjs'\nexport default { setupFiles: ['./failure-setup.ts'], globalSetup: ['./environment.ts'] }");
  put('.github/scripts/seq.mjs');
  put('packages/web/e2e/failure-setup.ts', "import { x } from './agent-browser'");
  put('packages/web/e2e/environment.ts', "const root = resolve(import.meta.dirname, '../../..')");
  put('packages/web/e2e/agent-browser.ts');
  put('packages/web/e2e/poll.ts');
  put('packages/web/e2e/fixtures/run.ndjson');
  put(spec('a'), "import { poll } from './poll'\nreadFileSync(resolve(import.meta.dirname, 'fixtures/run.ndjson'))");
  put(spec('b'), "import { thing } from '../src/thing'");
  put('packages/web/src/thing.ts', "import { cn } from '@/lib/cn'");
  put('packages/web/src/lib/cn.ts');
  const graph = referenceGraph(dir, [spec('a'), spec('b')]);
  assert.deepEqual([...graph.setup].sort(), [
    '.github/scripts/seq.mjs', 'packages/web/e2e/agent-browser.ts', 'packages/web/e2e/environment.ts',
    'packages/web/e2e/failure-setup.ts', 'packages/web/e2e/vitest.config.ts',
  ]);
  // Only what the config imports is bundled with it; setup files load at run time.
  assert.deepEqual([...graph.config].sort(), ['.github/scripts/seq.mjs', 'packages/web/e2e/vitest.config.ts']);
  assert.deepEqual([...graph.specs.get(spec('a'))].sort(), [spec('a'), 'packages/web/e2e/fixtures/run.ndjson', 'packages/web/e2e/poll.ts']);
  assert.deepEqual([...graph.specs.get(spec('b'))].sort(), [spec('b'), 'packages/web/src/lib/cn.ts', 'packages/web/src/thing.ts']);
});

const graph = {
  setup: new Set(['packages/web/e2e/vitest.config.ts', 'packages/web/e2e/agent-browser.ts', '.github/scripts/cockpit-test-sequencer.mjs']),
  specs: new Map([
    [spec('artifact-project-links'), new Set([spec('artifact-project-links'), 'packages/web/e2e/poll.ts'])],
    [spec('chat-code-fence'), new Set([spec('chat-code-fence'), 'packages/web/e2e/fixtures/images/', 'packages/web/src/routes/task-thread/thread-scroll.ts'])],
    [spec('smoke'), new Set([spec('smoke')])],
  ]),
};
const choose = (file, map = sampleMap()) => classify(file, { map, graph });

test('each kind of changed file selects its specs, none, or every spec', () => {
  const cases = [
    ['packages/web/src/routes/task-thread/markdown.tsx', [spec('artifact-project-links'), spec('chat-code-fence')]],
    ['packages/api-client/src/client.ts', [spec('artifact-project-links'), spec('chat-code-fence'), spec('smoke')]],
    ['packages/web/src/lib/unused.ts', []],
    ['packages/web/src/lib/new-file.ts', []],
    // A cockpit file a spec imports in Node counts for that spec even when no browser runs it.
    ['packages/web/src/routes/task-thread/thread-scroll.ts', [spec('chat-code-fence')]],
    [spec('smoke'), [spec('smoke')]],
    [spec('removed'), []],
    ['packages/web/e2e/poll.ts', [spec('artifact-project-links')]],
    ['packages/web/e2e/fixtures/images/a.png', [spec('chat-code-fence')]],
    ['packages/web/e2e/spec-map/bundle.ts', []],
    ['packages/web/e2e/README.md', []],
    ['AGENTS.md', []],
    ['docs/sdlc/ci.md', []],
    ['packages/web/src/routes/view.test.tsx', []],
    ['packages/web/src/test/setup.ts', []],
    ['scripts/e2e-affected.test.mjs', []],
    ['.github/workflows/e2e-spec-map.yml', []],
    ['packages/web/e2e/agent-browser.ts', null],
    ['.github/scripts/cockpit-test-sequencer.mjs', null],
    ['packages/web/e2e/fixtures/unnamed.ndjson', null],
    ['packages/web/src/index.css', null],
    ['packages/web/vite.config.ts', null],
    ['packages/cezar/src/server/server.ts', null],
    ['packages/contract/src/runs.ts', null],
    ['.ai/scripts/test-env-up.sh', null],
    ['pnpm-lock.yaml', null],
    ['something/new.txt', null],
    // hearsay-tools/squawk#3728: reviewed paths no browser spec reads.
    ['.oxlintrc.json', []],
    ['packages/cezar/src/lint/undocumented-env-name.ts', []],
    ['.ai/skills/dev-flow/SKILL.md', []],
    ['.claude/skills/pr-checks/SKILL.md', []],
    ['packages/cezar/scripts/benchmark-spawn.mjs', []],
    ['packages/web/scripts/benchmark-tabs.ts', []],
    ['AGENT_PROTOCOL.md', []],
    ['.env.example', []],
    ['squeal.config.json', []],
  ];
  for (const [file, specs] of cases) {
    const result = choose(file);
    assert.deepEqual(result.specs === null ? null : [...result.specs].sort(), specs, file);
    assert.ok(result.reason, file);
  }
});

test('a code file no process loaded selects no spec when the map lists every loaded file', () => {
  // .ai/specs/2026-11-20-e2e-selection-evidence-plan.md, slice 3.
  const map = sampleMap({ nodeLoaded: ['packages/cezar/src/server/server.ts', 'packages/web/e2e/agent-browser.ts'] });
  const atMap = new Set(['packages/cezar/src/server/server.ts', 'packages/cezar/src/delegation/owned-workspace-release.ts',
    'packages/web/e2e/agent-browser.ts', '.github/scripts/cockpit-test-sequencer.mjs', 'packages/contract/src/runs.ts',
    '.ai/scripts/probe-startup.ts', 'scripts/readers.mjs', '.ai/scripts/test-env-up.sh', 'packages/cezar/src/file-length.baseline.json',
    'packages/web/src/lib/unused.ts']);
  const pick = (file, chosenMap = map) => classify(file, { map: chosenMap, graph, atMap }).specs;
  for (const file of ['packages/cezar/src/delegation/owned-workspace-release.ts', 'packages/contract/src/runs.ts',
    '.ai/scripts/probe-startup.ts', 'scripts/readers.mjs']) {
    assert.deepEqual(pick(file), [], file);
    assert.match(classify(file, { map, graph, atMap }).reason, /no process the browser suite starts loads it/);
  }
  // .github/ is outside the covered roots: the suite setup still selects every spec for it.
  assert.equal(pick('.github/scripts/cockpit-test-sequencer.mjs'), null);
  // A file the suite setup reaches by a literal but no process loaded (a type-only import, say)
  // selects no spec. What the Vitest config imports still selects every spec: Vite bundles it into
  // a temporary file, so no coverage report names it.
  const definition = 'packages/cezar/src/core/runner-definition.ts';
  const withSetup = { ...graph, setup: new Set([...graph.setup, definition, 'scripts/check-workspace-resolution.mjs']),
    config: new Set(['packages/web/e2e/vitest.config.ts', 'scripts/check-workspace-resolution.mjs']) };
  const both = new Set([definition, 'scripts/check-workspace-resolution.mjs']);
  assert.deepEqual(classify(definition, { map, graph: withSetup, atMap: both }).specs, []);
  assert.equal(classify('scripts/check-workspace-resolution.mjs', { map, graph: withSetup, atMap: both }).specs, null);
  assert.equal(classify(definition, { map: sampleMap({ nodeLoaded: [definition] }), graph: withSetup, atMap: both }).specs, null);
  // When main changed the suite setup after the map, the setup may load it now: every spec.
  const setupDrift = selectSpecs({ files: [definition], map, graph: withSetup, specFiles: map.specs, atMap: both,
    drift: { files: ['packages/web/e2e/vitest.config.ts'], changes: new Map() } });
  assert.equal(setupDrift.all, true);
  assert.match(setupDrift.reason, /runner-definition\.ts needs every spec \(the browser suite setup loads it, and main changed the setup after the map\)/);
  // A spec that loads the file now, and the specs with incomplete evidence, still run.
  assert.deepEqual(classify('packages/web/e2e/poll.ts', { map, graph, atMap: new Set(['packages/web/e2e/poll.ts']) }).specs,
    [spec('artifact-project-links')]);
  const incomplete = sampleMap({ nodeLoaded: [], incomplete: [spec('smoke')] });
  assert.deepEqual(classify('scripts/readers.mjs', { map: incomplete, graph, atMap }).specs, [spec('smoke')]);
  // Main may have loaded the file since the map: the rule counts as mapped, so drift adds its specs.
  const drifted = selectSpecs({ files: ['scripts/readers.mjs'], map: { ...map, sources: { ...map.sources, 'packages/web/src/App.tsx': [2] } },
    graph, specFiles: map.specs, atMap, drift: { files: ['packages/web/src/App.tsx'], changes: new Map() } });
  assert.deepEqual(drifted.specs, [spec('smoke')]);
  // Loaded files, new files, files that are not code and maps without the list keep the other rules.
  assert.equal(pick('packages/cezar/src/server/server.ts'), null);
  assert.equal(pick('packages/web/e2e/agent-browser.ts'), null);
  assert.equal(pick('packages/cezar/src/delegation/new-file.ts'), null);
  assert.equal(pick('.ai/scripts/test-env-up.sh'), null);
  assert.equal(pick('packages/cezar/src/file-length.baseline.json'), null);
  assert.equal(pick('packages/cezar/src/delegation/owned-workspace-release.ts', sampleMap()), null);
  // Cockpit sources keep their browser evidence.
  assert.deepEqual(pick('packages/web/src/lib/unused.ts'), []);
  // The rule only narrows an answer of every spec: unit tests and reviewed no-spec paths stay at
  // none, even with incomplete specs (replay of hearsay-tools/squawk#3961 and hearsay-tools/squawk#3954).
  const withIncomplete = sampleMap({ nodeLoaded: [], incomplete: [spec('smoke')] });
  const unitAtMap = new Set(['packages/cezar/src/workflows/process-waits.test.ts', 'packages/cezar/src/lint/rule.ts']);
  assert.deepEqual(classify('packages/cezar/src/workflows/process-waits.test.ts', { map: withIncomplete, graph, atMap: unitAtMap }).specs, []);
  assert.deepEqual(classify('packages/cezar/src/lint/rule.ts', { map: withIncomplete, graph, atMap: unitAtMap }).specs, []);
  // A helper a spec loads now keeps its readers, adds the incomplete specs and counts as mapped.
  const helper = classify('packages/web/e2e/poll.ts', { map: withIncomplete, graph, atMap: new Set(['packages/web/e2e/poll.ts']) });
  assert.deepEqual(helper.specs, [spec('artifact-project-links'), spec('smoke')]);
  assert.equal(helper.mapped, true);
  assert.match(mapProblem(sampleMap({ nodeLoaded: [3] })), /loaded files/);
  assert.match(mapProblem(sampleMap({ nodeLoaded: 'x' })), /loaded files/);
});

test('code the suite setup loads selects the boot spec and its own answer; durations select none', () => {
  // Owner decisions, 2026-11-20 (.ai/specs/2026-11-20-e2e-selection-evidence-plan.md).
  const file = 'packages/cezar/src/core/runner-definition.ts';
  const withSetup = { ...graph, setup: new Set([...graph.setup, file, '.github/test-durations.json', '.github/cockpit-test-durations.json']) };
  const map = sampleMap({ functions: { [file]: [{ start: 1, end: 50, specs: [], startup: true }, { start: 10, end: 20, specs: [1] }] } });
  const pick = (ranges, boot = spec('smoke')) => classify(file, { map, graph: withSetup, boot, changes: new Map([[file, ranges]]) });
  assert.deepEqual(pick([{ start: 15, end: 15 }]).specs, [spec('chat-code-fence'), spec('smoke')]);
  assert.match(pick([{ start: 15, end: 15 }]).reason, /and the boot spec: the browser suite setup loads it/);
  // Code without its own answer (an e2e helper no spec names) still selects every spec.
  assert.equal(classify('packages/web/e2e/agent-browser.ts', { map, graph: withSetup, boot: spec('smoke') }).specs, null);
  // Without a boot spec, setup code selects every spec.
  assert.equal(pick([{ start: 15, end: 15 }], null).specs, null);
  for (const durations of ['.github/test-durations.json', '.github/cockpit-test-durations.json']) {
    assert.deepEqual(classify(durations, { map, graph: withSetup, boot: spec('smoke') }).specs, [], durations);
  }
});

test('a reviewed no-spec path still selects the specs that load it, and setup still selects every spec', () => {
  const readsSkill = { setup: new Set([...graph.setup, '.ai/skills/setup-loaded.md']), specs: new Map([
    ...graph.specs, [spec('smoke'), new Set([spec('smoke'), '.ai/skills/fixture/SKILL.md'])],
  ]) };
  const pick = file => classify(file, { map: sampleMap(), graph: readsSkill });
  assert.deepEqual(pick('.ai/skills/fixture/SKILL.md').specs, [spec('smoke')]);
  assert.equal(pick('.ai/skills/setup-loaded.md').specs, null);
});

test('selection: every spec when one file needs it, and incomplete specs whenever a bundled source changed', () => {
  const specFiles = sampleMap().specs;
  const map = sampleMap({ incomplete: [spec('smoke')] });
  const pick = files => selectSpecs({ files, map, graph, specFiles });
  assert.deepEqual(pick(['packages/web/src/routes/task-thread/markdown.tsx']).specs, specFiles);
  assert.deepEqual(pick(['packages/web/e2e/poll.ts']).specs, [spec('artifact-project-links')]);
  assert.deepEqual(pick(['packages/web/src/lib/unused.ts', 'docs/x.md']).specs, [spec('smoke')]);
  assert.deepEqual(pick(['docs/x.md']).specs, []);
  const all = pick(['docs/x.md', 'packages/cezar/src/index.ts']);
  assert.equal(all.all, true);
  assert.deepEqual(all.specs, specFiles);
  assert.deepEqual(all.lines.map(line => line.file), ['docs/x.md', 'packages/cezar/src/index.ts']);
  assert.match(all.reason, /^packages\/cezar\/src\/index\.ts needs every spec \(server or CLI code/);
});

test('when the branch touches mapped code, mapped files main changed after the map add their specs', () => {
  // hearsay-tools/squawk#3733 review: main adds new-util.ts after the map and imports it from App.tsx.
  const map = sampleMap({ sources: { ...sampleMap().sources, 'packages/web/src/App.tsx': [2] } });
  const drift = { files: ['packages/web/src/App.tsx', 'packages/web/src/lib/new-util.ts', 'packages/cezar/src/index.ts'], changes: new Map() };
  const pick = files => selectSpecs({ files, map, graph, specFiles: map.specs, drift });
  const result = pick(['packages/web/src/lib/new-util.ts', 'packages/web/src/routes/task-thread/markdown.tsx']);
  assert.equal(result.all, false);
  assert.deepEqual(result.specs, map.specs);
  // The branch's own file is not drift; a drift file that needs every spec adds nothing.
  assert.deepEqual(result.drift.map(line => line.file), ['packages/web/src/App.tsx']);
  // Main's changes add nothing to a branch that touches no mapped code.
  assert.deepEqual(pick(['.oxlintrc.json']).specs, []);
});

test('a mapped caller main changed keeps its evidenced specs when other drift lines have none', () => {
  // hearsay-tools/squawk#3733 review round 2: main adds a call inside run() and a new function at EOF.
  const file = 'packages/cezar/src/core/caller.ts';
  const map = sampleMap({ functions: {
    [file]: [{ start: 1, end: 50, specs: [2] }],
    'packages/cezar/src/core/helper.ts': [{ start: 1, end: 20, specs: [0] }],
  } });
  const drift = { files: [file], changes: new Map([[file, [{ start: 10, end: 10 }, { start: 100, end: 101 }]]]) };
  const result = selectSpecs({ files: ['packages/cezar/src/core/helper.ts'], map, graph, specFiles: map.specs, drift,
    changes: new Map([['packages/cezar/src/core/helper.ts', [{ start: 5, end: 5 }]]]) });
  assert.deepEqual(result.specs, [spec('artifact-project-links'), spec('smoke')]);
  // A drift hunk across the end of a recorded function keeps that function's specs.
  const across = { files: [file], changes: new Map([[file, [{ start: 45, end: 60 }]]]) };
  assert.deepEqual(selectSpecs({ files: ['packages/cezar/src/core/helper.ts'], map, graph, specFiles: map.specs, drift: across,
    changes: new Map([['packages/cezar/src/core/helper.ts', [{ start: 5, end: 5 }]]]) }).specs, [spec('artifact-project-links'), spec('smoke')]);
  // The branch's own lines in top-level code select the boot spec and the specs that ran the file.
  const own = selectSpecs({ files: [file], map, graph, specFiles: map.specs, changes: drift.changes, boot: spec('chat-code-fence') });
  assert.equal(own.all, false);
  assert.deepEqual(own.specs, [spec('chat-code-fence'), spec('smoke')]);
});

test('startup and top-level edits select the boot spec, not every spec', () => {
  // .ai/specs/2026-11-20-e2e-selection-evidence-plan.md, slice 2.
  const file = 'packages/cezar/src/ci-wait/tool-catalog.ts';
  const map = sampleMap({ functions: { [file]: [
    { start: 3, end: 60, specs: [], startup: true }, // the module's top-level code
    { start: 10, end: 20, specs: [0], startup: true }, // ran at boot and in one spec
    { start: 25, end: 30, specs: [], startup: true }, // ran only at boot
    { start: 40, end: 50, specs: [1] }, // ran in one spec only
    { start: 52, end: 55, specs: [] }, // never ran
  ] } });
  const pick = (ranges, boot = spec('smoke')) => selectSpecs({ files: [file], map, graph, specFiles: map.specs,
    changes: new Map([[file, ranges]]), boot });
  const at = (...ranges) => pick(ranges.map(([start, end = start]) => ({ start, end }))).specs;
  assert.deepEqual(at([45]), [spec('chat-code-fence')]);
  assert.deepEqual(at([53]), []);
  // Code the boot ran, top-level code, an import above the first recorded line, and a line past
  // the last one: the boot spec and every spec that ran a function of the file.
  const fileSpecs = [spec('artifact-project-links'), spec('chat-code-fence'), spec('smoke')];
  assert.deepEqual(at([27]), fileSpecs);
  assert.deepEqual(at([15]), fileSpecs);
  assert.deepEqual(at([35]), fileSpecs);
  assert.deepEqual(at([1]), fileSpecs);
  assert.deepEqual(at([70]), fileSpecs);
  // A range across two functions counts as top-level code.
  assert.deepEqual(at([28, 42]), fileSpecs);
  assert.match(pick([{ start: 27, end: 27 }]).lines[0].reason, /boot spec/);
  // Without a spec with complete evidence there is no boot spec: every spec runs.
  assert.equal(pick([{ start: 27, end: 27 }], null).all, true);
  assert.equal(pick([{ start: 45, end: 45 }], null).all, false);
  // Drift on main's boot code adds the boot spec and the file's specs.
  const drift = { files: [file], changes: new Map([[file, [{ start: 27, end: 27 }]]]) };
  const helper = 'packages/cezar/src/core/helper.ts';
  const withHelper = { ...map, functions: { ...map.functions, [helper]: [{ start: 1, end: 9, specs: [1] }] } };
  assert.deepEqual(selectSpecs({ files: [helper], map: withHelper, graph, specFiles: map.specs, drift, boot: spec('smoke'),
    changes: new Map([[helper, [{ start: 5, end: 5 }]]]) }).specs, fileSpecs);
});

test('one hunk across two handlers a boot-time factory registers keeps both handlers\' specs', () => {
  // PR review (hearsay-tools/squawk#3986): route handlers nested in createApp.
  const file = 'packages/cezar/src/server/server.ts';
  const map = sampleMap({ functions: { [file]: [
    { start: 1, end: 100, specs: [], startup: true },
    { start: 10, end: 60, specs: [], startup: true }, // createApp
    { start: 20, end: 30, specs: [0] },
    { start: 35, end: 45, specs: [1] },
  ] } });
  const result = selectSpecs({ files: [file], map, graph, specFiles: map.specs, boot: spec('smoke'),
    changes: new Map([[file, [{ start: 25, end: 40 }]]]) });
  assert.deepEqual(result.specs, [spec('artifact-project-links'), spec('chat-code-fence'), spec('smoke')]);
});

test('the boot spec is the shortest spec with complete evidence', () => {
  const map = sampleMap({ incomplete: [spec('chat-code-fence')] });
  const specFiles = map.specs;
  assert.equal(bootSpec(map, specFiles, { 'chat-code-fence.e2e.ts': 1, 'smoke.e2e.ts': 5, 'artifact-project-links.e2e.ts': 9 }), spec('smoke'));
  assert.equal(bootSpec(map, specFiles), spec('artifact-project-links'));
  assert.equal(bootSpec(sampleMap({ incomplete: sampleMap().specs }), specFiles), null);
  // A spec removed since the map never boots; with no current spec left, there is no boot spec.
  assert.equal(bootSpec(map, [spec('artifact-project-links')], { 'smoke.e2e.ts': 1 }), spec('artifact-project-links'));
  assert.equal(bootSpec(map, [spec('chat-code-fence')]), null);
  const file = 'packages/cezar/src/boot.ts';
  const booting = sampleMap({ functions: { [file]: [{ start: 1, end: 9, specs: [], startup: true }, { start: 2, end: 3, specs: [], startup: true }] } });
  const removed = selectSpecs({ files: [file], map: booting, graph, specFiles: [spec('artifact-project-links')],
    changes: new Map([[file, [{ start: 2, end: 2 }]]]) });
  assert.deepEqual(removed.specs, [spec('artifact-project-links')]);
  const none = selectSpecs({ files: [file], map: { ...booting, incomplete: [spec('artifact-project-links')] }, graph,
    specFiles: [spec('artifact-project-links')], changes: new Map([[file, [{ start: 2, end: 2 }]]]) });
  assert.equal(none.all, true);
});

test('specs added or changed on main after the map run when the branch touches mapped code', () => {
  // hearsay-tools/squawk#3733 review thread: the map predates markdown-regression.e2e.ts.
  const specFiles = [...sampleMap().specs, spec('markdown-regression'), spec('late')].sort();
  const drift = { files: [spec('markdown-regression'), 'packages/web/e2e/poll.ts'], changes: new Map() };
  const pick = files => selectSpecs({ files, map: sampleMap(), graph, specFiles, drift });
  const result = pick(['packages/web/src/routes/task-thread/markdown.tsx']);
  assert.deepEqual(result.specs, [spec('artifact-project-links'), spec('chat-code-fence'), spec('late'), spec('markdown-regression')]);
  assert.deepEqual(result.drift.map(line => line.file), [spec('markdown-regression'), 'packages/web/e2e/poll.ts']);
  assert.deepEqual(pick(['docs/x.md']).specs, []);
});

test('an empty selection stays empty and carries its reason', () => {
  const specFiles = sampleMap().specs;
  const pick = files => selectSpecs({ files, map: sampleMap(), graph, specFiles });
  const empty = pick(['.oxlintrc.json', 'docs/x.md']);
  assert.equal(empty.all, false);
  assert.deepEqual(empty.specs, []);
  assert.equal(empty.reason, 'no changed file reaches a browser spec');
  assert.equal(pick([]).reason, 'the branch changes no file');
  assert.equal(pick(['packages/web/e2e/poll.ts']).reason, 'the specs the changed files reach');
});

function repository(t) {
  const { dir, put } = tempDir(t);
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Test');
  put('packages/web/e2e/vitest.config.ts', "export default { setupFiles: ['./failure-setup.ts'] }");
  put('packages/web/e2e/failure-setup.ts');
  for (const name of ['artifact-project-links', 'chat-code-fence', 'smoke']) put(spec(name));
  put('packages/web/src/routes/task-thread/markdown.tsx', 'export function Markdown() {}\n');
  put('.github/cockpit-test-durations.json', JSON.stringify({ durationsMs: { 'artifact-project-links.e2e.ts': 90_000, 'chat-code-fence.e2e.ts': 60_000 } }));
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  // The map lives outside the repository: an untracked file inside it is a change.
  const maps = tempDir(t);
  const map = (overrides = {}) => {
    maps.put('map.json', JSON.stringify(sampleMap({ commit: git('rev-parse', 'HEAD'), ...overrides })));
    return `--map=${join(maps.dir, 'map.json')}`;
  };
  return { dir, put, map };
}

const affected = (cwd, ...args) => spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });

test('CI planning runs nothing for an empty selection or a missing map', t => {
  const { dir, put, map } = repository(t);
  const cwd = process.cwd();
  const mapFlag = map();
  process.chdir(dir);
  try {
    assert.equal(main(['--ci', '--plan', mapFlag]), 0);
    assert.equal(main(['--ci', '--plan', '--map=missing.json']), 0);
    put('packages/web/src/routes/task-thread/markdown.tsx', 'export function Markdown() { return 1 }\n');
    assert.equal(main(['--ci', '--plan', mapFlag]), 0);
    assert.equal(main(['--plan', mapFlag]), 0);
  } finally {
    process.chdir(cwd);
  }
});
test('--plan diffs the working tree against the map’s commit, untracked files included, and runs nothing', t => {
  const { dir, put, map } = repository(t);
  put('packages/web/src/routes/task-thread/markdown.tsx', 'export function Markdown() { return 1 }\n');
  put('docs/new-page.md', '# New\n');
  const result = affected(dir, '--plan', map());
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Spec map: .*map\.json, commit [0-9a-f]{8}/);
  assert.match(result.stdout, /docs\/new-page\.md: 0 specs \(documentation\)/);
  assert.match(result.stdout, /markdown\.tsx: 2 specs \(the specs that run it\)/);
  assert.match(result.stdout, /→ packages\/web\/e2e\/artifact-project-links\.e2e\.ts\n {2}→ packages\/web\/e2e\/chat-code-fence\.e2e\.ts\n/);
  assert.match(result.stdout, /Selected 2 of 3 specs, about 3 min\./);
  assert.doesNotMatch(result.stdout, /TEST_E2E_STATUS/);
});

test('--plan reads the files that existed at the map\'s commit for the loaded-file rule', t => {
  const { dir, put, map } = repository(t);
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  put('packages/cezar/src/cli/unused.ts', 'export const a = 1;\n');
  git('add', '.'); git('commit', '-qm', 'cli');
  const mapFlag = map({ nodeLoaded: ['packages/cezar/src/server.ts'] });
  put('packages/cezar/src/cli/unused.ts', 'export const a = 2;\n');
  put('packages/cezar/src/cli/added.ts', 'export const b = 1;\n');
  const result = affected(dir, '--plan', mapFlag);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /unused\.ts: 0 specs \(no process the browser suite starts loads it\)/);
  assert.match(result.stdout, /added\.ts needs every spec \(server or CLI code without function evidence\)/);
});

test('a change no spec reaches runs nothing and exits 0', t => {
  const { dir, put, map } = repository(t);
  put('docs/new-page.md', '# New\n');
  const result = affected(dir, map());
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Selected 0 of 3 specs: no changed file reaches a browser spec\./);
  assert.match(result.stdout, /No browser spec reaches these changes, so none runs\./);
});

test('the branch’s own changes decide, whatever merged after the map’s commit', t => {
  const { dir, put, map } = repository(t);
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  const mapFlag = map();
  // main moves past the map with a change that alone selects every spec.
  put('packages/cezar/src/server/server.ts', 'export const port = 1;\n');
  git('add', '.'); git('commit', '-qm', 'later merge');
  git('switch', '-qc', 'feature');
  put('packages/web/src/routes/task-thread/markdown.tsx', 'export function Markdown() { return 1 }\n');
  git('commit', '-qam', 'own change');
  const result = affected(dir, '--plan', '--base=main', mapFlag);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /server\.ts/);
  assert.match(result.stdout, /markdown\.tsx: 2 specs \(the specs that run it\)/);
  assert.match(result.stdout, /Selected 2 of 3 specs/);
  // Without --base the branch forks from main as well.
  assert.match(affected(dir, '--plan', mapFlag).stdout, /Selected 2 of 3 specs/);
});

test('a synthetic merge selects from the PR alone when --base is the base branch’s current tip', t => {
  const { dir, put, map } = repository(t);
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  const mapFlag = map();
  const oldBase = git('rev-parse', 'HEAD');
  git('switch', '-qc', 'feature');
  put('packages/web/src/routes/task-thread/markdown.tsx', 'export function Markdown() { return 1 }\n');
  git('commit', '-qam', 'own change');
  git('switch', '-q', 'main');
  put('packages/cezar/src/server/server.ts', 'export const port = 1;\n');
  git('add', '.'); git('commit', '-qm', 'later merge');
  // GitHub's merge ref: base tip first, PR head second.
  git('switch', '-q', '--detach', 'main');
  git('merge', '-q', '--no-ff', '--no-edit', 'feature');
  assert.match(affected(dir, '--plan', '--base=main', mapFlag).stdout, /Selected 2 of 3 specs/);
  // The event's base SHA can be older than the merge's base parent: main's changes count again.
  assert.match(affected(dir, '--plan', `--base=${oldBase}`, mapFlag).stdout, /server\.ts needs every spec/);
});

test('a base the branch shares no history with selects every spec, with the reason', t => {
  const { dir, map } = repository(t);
  const result = affected(dir, '--plan', '--base=no-such-ref', map());
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /HEAD has no merge-base with no-such-ref\. Every spec runs\./);
  assert.match(result.stdout, /Selected 3 of 3 specs/);
});

test('--ci reports each changed file and runs no spec for an empty selection, with its reason', t => {
  const { dir, put, map } = repository(t);
  put('.oxlintrc.json', '{}\n');
  put('.ai/skills/x/SKILL.md', '# x\n');
  const result = affected(dir, '--ci', '--plan', map());
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, / {2}\.oxlintrc\.json: 0 specs \(a lint configuration/);
  assert.match(result.stdout, / {2}\.ai\/skills\/x\/SKILL\.md: 0 specs \(repository skills/);
  assert.match(result.stdout, /Selected 0 of 3 specs: no changed file reaches a browser spec\./);
  assert.match(result.stdout, /PR CI runs no browser spec: the selector chose no spec: no changed file reaches a browser spec\./);
});

test('--ci prints the files main changed after the map', t => {
  const { dir, put, map } = repository(t);
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  const mapFlag = map();
  put(spec('late'), '');
  git('add', '.'); git('commit', '-qm', 'later spec');
  put('packages/web/src/routes/task-thread/markdown.tsx', 'export function Markdown() { return 1 }\n');
  const result = affected(dir, '--ci', '--plan', '--base=main', mapFlag);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /late\.e2e\.ts, changed on main after the map: 1 spec/);
  assert.match(result.stdout, /Selected 3 of 4 specs/);
});

test('a map whose commit the clone lacks selects every spec', t => {
  const { dir, map } = repository(t);
  const result = affected(dir, '--plan', map({ commit: 'b'.repeat(40) }));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /the map's commit bbbbbbbb is not in this clone and cannot be fetched\. Every spec runs\./);
  assert.match(result.stdout, /Selected 3 of 3 specs/);
});

test('a --map file that cannot be read is an error, not a full run', t => {
  const { dir } = repository(t);
  const result = affected(dir, '--plan', '--map=missing.json');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /cannot read the spec map at .*missing\.json/);
});

test('CI runs a shorter selection with shard flags and runs nothing for every spec, no spec or a failed selector', t => {
  const { dir, put, map } = repository(t);
  put('.ai/scripts/e2e.sh', 'printf "arg=%s\\n" "$@"; exit 19\n');
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git('add', '.'); git('commit', '-qm', 'browser command');
  const mapFlag = map();
  put('packages/web/src/routes/task-thread/markdown.tsx', 'export function Markdown() { return 1 }\n');
  const selected = affected(dir, '--ci', '--shard=2/8', mapFlag);
  assert.equal(selected.status, 19, selected.stdout + selected.stderr);
  assert.match(selected.stdout, /markdown\.tsx: 2 specs/, 'the CI log keeps the reason for each file');
  assert.match(selected.stdout, /arg=--shard=2\/8/);
  assert.match(selected.stdout, /arg=packages\/web\/e2e\/artifact-project-links.e2e.ts/);
  assert.match(selected.stdout, /arg=packages\/web\/e2e\/chat-code-fence.e2e.ts/);
  assert.doesNotMatch(selected.stdout, /arg=.*smoke.e2e.ts/);
  assert.match(selected.stdout, /arg=--passWithNoTests=true/);
  assert.doesNotMatch(selected.stdout, /not-selected/);
  git('restore', 'packages/web/src/routes/task-thread/markdown.tsx');
  const cases = [
    [mapFlag, /PR CI runs no browser spec: the selector chose no spec: the branch changes no file\./],
    ['--map=missing.json', /PR CI runs no browser spec: the selector failed: cannot read the spec map at .*missing\.json/],
  ];
  put('packages/web/vite.config.ts', 'export default {}\n');
  const every = affected(dir, '--ci', '--shard=2/8', mapFlag);
  git('clean', '-qf', 'packages/web/vite.config.ts');
  // A mapped source that every spec ran selects the full list without the every-spec flag.
  put('packages/api-client/src/client.ts', 'export const client = 1\n');
  const mappedEvery = affected(dir, '--ci', '--shard=2/8', mapFlag);
  git('clean', '-qf', 'packages/api-client');
  assert.match(mappedEvery.stdout, /client\.ts: 3 specs/);
  for (const [result, reason] of [...cases.map(([flag, reason]) => [affected(dir, '--ci', '--shard=2/8', flag), reason]),
    [every, /Selected 3 of 3 specs[^]*PR CI runs no browser spec: the selector chose every spec: packages\/web\/vite\.config\.ts needs every spec/],
    [mappedEvery, /Selected 3 of 3 specs[^]*PR CI runs no browser spec: the selector chose every spec: the specs the changed files reach\./]]) {
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, reason);
    assert.match(result.stdout, /^TEST_E2E_STATUS=not-selected$/m);
    assert.doesNotMatch(result.stdout, /arg=/, 'no browser starts');
  }
});
function runPrBrowserStep(t, change) {
  const { dir, put, map } = repository(t);
  put('.ai/scripts/e2e.sh', 'printf "arg=%s\\n" "$@"; echo TEST_E2E_STATUS=passed\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'browser command'], { cwd: dir });
  const mapFile = map().slice('--map='.length);
  change(put);
  const temp = tempDir(t);
  // Keep the workflow command intact. Only map download and the costly browser are fixture seams.
  temp.put('node', `#!/bin/sh
if [ "$1" = scripts/e2e-affected.mjs ]; then
  shift
  exec "$REAL_NODE" "$SELECTOR_SCRIPT" "$@" "--map=$MAP_FILE"
fi
exec "$REAL_NODE" "$MARKER_SCRIPT" "$@"
`);
  chmodSync(join(temp.dir, 'node'), 0o755);
  temp.put('summary.md', '');
  const workflow = yaml.parse(readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'));
  const run = workflow.jobs['cockpit-browser'].steps.find(step => step.id === 'e2e-pr').run;
  assert.match(run, /--base="origin\/\$BASE_REF"/);
  execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: dir });
  const result = spawnSync('bash', ['-eu', '-c', run.replace('${{ matrix.shard }}', '1')], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, PATH: `${temp.dir}:${process.env.PATH}`,
      RUNNER_TEMP: temp.dir, GITHUB_STEP_SUMMARY: join(temp.dir, 'summary.md'), GITHUB_EVENT_NAME: 'pull_request_target',
      BASE_REF: 'main', REAL_NODE: process.execPath, SELECTOR_SCRIPT: script, MAP_FILE: mapFile,
      MARKER_SCRIPT: fileURLToPath(new URL('../.github/scripts/require-e2e-passed.cjs', import.meta.url)) },
  });
  return { result, summary: readFileSync(join(temp.dir, 'summary.md'), 'utf8') };
}

test('PR browser workflow logs leave the mapped selection intact', t => {
  const { result, summary } = runPrBrowserStep(t, put => put('packages/web/src/routes/task-thread/markdown.tsx', 'export function Markdown() { return 1 }\n'));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Selected 2 of 3 specs/);
  assert.match(result.stdout, /arg=packages\/web\/e2e\/artifact-project-links.e2e.ts/);
  assert.match(result.stdout, /arg=packages\/web\/e2e\/chat-code-fence.e2e.ts/);
  assert.doesNotMatch(result.stdout, /arg=.*smoke.e2e.ts/);
  assert.equal(summary, '');
});

test('PR browser workflow step passes without a browser when the selection is every spec', t => {
  const { result, summary } = runPrBrowserStep(t, put => put('packages/web/vite.config.ts', 'export default {}\n'));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /arg=/);
  assert.match(summary, /PR CI runs no browser spec: the selector chose every spec: packages\/web\/vite\.config\.ts needs every spec/);
});

test('mock function edits select only specs that executed that function, plus incomplete specs', () => {
  const file = 'packages/cezar/scripts/mock-codex.mjs';
  const map = sampleMap({ incomplete: [spec('smoke')], functions: { [file]: [
    { start: 1, end: 100, specs: [0, 1, 2] },
    { start: 10, end: 20, specs: [0] },
    { start: 30, end: 40, specs: [1] },
  ] } });
  const result = selectSpecs({ files: [file], map, graph, specFiles: map.specs,
    changes: new Map([[file, [{ start: 12, end: 12 }]]]) });
  assert.equal(result.all, false);
  assert.deepEqual(result.specs, [spec('artifact-project-links'), spec('smoke')]);
  assert.equal(selectSpecs({ files: [file], map, graph, specFiles: map.specs }).all, true);
});

test('function maps reject malformed ranges instead of silently omitting specs', () => {
  assert.match(mapProblem(sampleMap({ functions: { 'mock.mjs': [{ start: 4, end: 2, specs: [] }] } })), /function ranges/);
  assert.match(mapProblem(sampleMap({ functions: { 'mock.mjs': [{ start: 1, end: 2, specs: [], startup: false }] } })), /function ranges/);
  assert.equal(mapProblem(sampleMap({ functions: { 'mock.mjs': [{ start: 1, end: 2, specs: [], startup: true }] } })), null);
});


test('diff hunks keep old line positions and include both sides of insertion boundaries', () => {
  assert.deepEqual(changedLines('@@ -12 +12 @@\n-x\n+y\n@@ -30,0 +31,2 @@\n+a\n+b'), [
    { start: 12, end: 12 }, { start: 30, end: 31 },
  ]);
});
