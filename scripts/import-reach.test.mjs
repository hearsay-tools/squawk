import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { main, matchExports, parseJsonc } from './import-reach.mjs';

// A git checkout in a temporary directory; the files stay untracked, as a new split file does.
function checkout(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'import-reach-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  return root;
}

const reachJson = (root, module) => JSON.parse(main([module, '--json'], root));
const loaders = (root, module) => reachJson(root, module).reaching.map((r) => r.file);

const EDGES = {
  'src/hub.ts': 'export class Hub {}\nexport type HubShape = { id: string };\n',
  'src/reexport.ts': "export { Hub } from './hub.js';\n",
  'src/star.ts': "export * from './hub';\n",
  'src/static.test.ts': "import { Hub } from './hub.js';\ntest('a', () => new Hub());\n",
  'src/via-reexport.test.ts': "import { Hub } from './reexport.js';\ntest('a', () => Hub);\n",
  'src/via-star.test.ts': "import * as s from './star.js';\ntest('a', () => s);\n",
  'src/dynamic.test.ts': "test('a', async () => { await import('./hub.js'); });\n",
  'src/template.test.ts': "test('a', async () => { await import(`./hub.js`); });\n",
  'src/require.test.cjs': "const { Hub } = require('./hub.ts');\ntest('a', () => Hub);\n",
  'src/side-effect.test.ts': "import './hub.js';\ntest('a', () => {});\n",
  'src/import-type.test.ts': "import type { HubShape } from './hub.js';\ntest('a', () => ({} as HubShape));\n",
  'src/inline-type.test.ts': "import { type HubShape } from './hub.js';\ntest('a', () => ({} as HubShape));\n",
  'src/type-use.test.ts': "import { Hub } from './hub.js';\nconst h: Hub | null = null;\ntest('a', () => h);\n",
  'src/export-type.ts': "export type { HubShape } from './hub.js';\n",
  'src/via-export-type.test.ts': "import { x } from './export-type.js';\ntest('a', () => x);\n",
  'src/mock.test.ts': "vi.mock('./hub.js');\ntest('a', () => {});\n",
};

test('static imports, export … from, dynamic import() and require() load the module; type-only imports and vi.mock do not', (t) => {
  const root = checkout(t, EDGES);
  assert.deepEqual(loaders(root, 'src/hub.ts'), [
    'src/dynamic.test.ts', 'src/require.test.cjs', 'src/side-effect.test.ts', 'src/static.test.ts',
    'src/template.test.ts', 'src/via-reexport.test.ts', 'src/via-star.test.ts',
  ]);
});

test('workspace package names resolve through exports, a dist target maps to src, and tsconfig paths resolve', (t) => {
  const root = checkout(t, {
    'packages/lib/package.json': JSON.stringify({ name: '@x/lib', exports: { '.': './src/index.ts', './*': './src/*.ts', './*.test': null } }),
    'packages/lib/src/index.ts': "export * from './hub';\n",
    'packages/lib/src/hub.ts': 'export const hub = 1;\n',
    'packages/srv/package.json': JSON.stringify({ name: '@x/srv', exports: { './app': './dist/app.js' } }),
    'packages/srv/src/app.ts': "export { hub } from '@x/lib/hub';\n",
    'packages/web/package.json': JSON.stringify({ name: '@x/web' }),
    'packages/web/tsconfig.json': '{\n  // comment\n  "compilerOptions": { "paths": { "@/*": ["./src/*"], }, },\n}\n',
    'packages/web/src/util.ts': "export { hub } from '@x/srv/app';\n",
    'packages/web/src/root.test.ts': "import { hub } from '@x/lib';\ntest('a', () => hub);\n",
    'packages/web/src/alias.test.ts': "import { hub } from '@/util';\ntest('a', () => hub);\n",
  });
  assert.deepEqual(loaders(root, 'packages/lib/src/hub.ts'), ['packages/web/src/alias.test.ts', 'packages/web/src/root.test.ts']);
});

test('the report ranks direct importers by the test files that load the module through them, and names its metrics', (t) => {
  const root = checkout(t, {
    'src/hub.ts': 'export const hub = 1;\n',
    'src/kit.testkit.ts': "export { hub } from './hub.js';\n",
    'src/direct.ts': "export { hub } from './hub.js';\n",
    'src/a.test.ts': "import { hub } from './kit.testkit.js';\ntest('a', () => hub);\nit('b', () => hub);\n",
    'src/b.test.ts': "import { hub } from './kit.testkit.js';\ntest.each([1, 2])('c %s', () => hub);\n",
    'src/c.test.ts': "import { hub } from './direct.js';\ntest.skip('d', () => hub);\n",
    '.github/test-durations.json': JSON.stringify({ durationsMs: { 'src/a.test.ts': 100, 'src/b.test.ts': 50 } }),
  });
  const report = reachJson(root, 'src/hub.ts');
  assert.deepEqual(report.importers, [
    { importer: 'src/kit.testkit.ts', testFiles: 2, tests: 3 },
    { importer: 'src/direct.ts', testFiles: 1, tests: 1 },
  ]);
  assert.deepEqual({ testFiles: report.testFiles, tests: report.tests, ciMs: report.ciMs, untimed: report.untimedTestFiles }, { testFiles: 3, tests: 4, ciMs: 150, untimed: 1 });
  const text = main(['src/hub.ts'], root);
  assert.match(text, /^test files that load it at runtime: 3/m);
  assert.match(text, /^cost tests \(test\(\)\/it\(\) call sites, at least 1 per file\): 4$/m);
  assert.match(text, /^cost ci-ms \(\.github\/test-durations\.json medians\): 150; test files without a duration: 1$/m);
  assert.match(text, /^2\t3\tsrc\/kit\.testkit\.ts$/m);
});

test('moving tests to a split-out file that does not load the module lowers the tests cost, not the file count', (t) => {
  const engine = "import { hub } from './hub.js';\n";
  const before = checkout(t, {
    'src/hub.ts': 'export const hub = 1;\n',
    'src/run.test.ts': `${engine}test('a', () => hub);\ntest('b', () => hub);\ntest('c', () => hub);\n`,
  });
  const after = checkout(t, {
    'src/hub.ts': 'export const hub = 1;\n',
    'src/run.test.ts': `${engine}test('a', () => hub);\n`,
    'src/run-engine-free.test.ts': "test('b', () => 1);\ntest('c', () => 1);\n",
  });
  const [b, a] = [reachJson(before, 'src/hub.ts'), reachJson(after, 'src/hub.ts')];
  assert.deepEqual([b.testFiles, b.tests], [1, 3]);
  assert.deepEqual([a.testFiles, a.tests], [1, 1]);
});

test('a test file loads the setup files of the nearest Vitest config that includes it', (t) => {
  const root = checkout(t, {
    'packages/a/vitest.config.ts': "export default { test: { include: ['src/**/*.test.ts'], setupFiles: ['./vitest.setup.ts'] } };\n",
    'packages/a/vitest.setup.ts': "import { hub } from './src/hub.js';\nhub();\n",
    'packages/a/src/hub.ts': 'export const hub = () => 1;\n',
    'packages/a/src/plain.test.ts': "test('a', () => 1);\n",
    'packages/a/test/node.test.ts': "test('a', () => 1);\n",
    'packages/a/src/e2e/vitest.config.ts': "export default { test: { setupFiles: ['./e2e-setup.ts'] } };\n",
    'packages/a/src/e2e/e2e-setup.ts': 'export {};\n',
    'packages/a/src/e2e/flow.test.ts': "test('a', () => 1);\n",
    'packages/b/src/other.test.ts': "test('a', () => 1);\n",
  });
  assert.deepEqual(loaders(root, 'packages/a/src/hub.ts'), ['packages/a/src/plain.test.ts']);
  assert.deepEqual(loaders(root, 'packages/a/src/e2e/e2e-setup.ts'), ['packages/a/src/e2e/flow.test.ts']);
  assert.equal(main(['packages/a/src/hub.ts', '--files', 'packages/a/src/plain.test.ts'], root),
    'packages/a/src/plain.test.ts: packages/a/src/plain.test.ts → packages/a/vitest.setup.ts → packages/a/src/hub.ts');
});

test('the tests cost counts modifier chains and curried registrations, and leaves out skip and todo', (t) => {
  const root = checkout(t, {
    'src/hub.ts': 'export const hub = 1;\n',
    'src/a.test.ts': [
      "import { hub } from './hub.js';",
      "it.runIf(true)('a', () => hub);",
      "it.skipIf(false)('b', () => hub);",
      "it.concurrent.each([1])('c', () => hub);",
      "test.only('d', () => hub);",
      "it.concurrent('e', () => hub);",
      "it.skip('f', () => hub);",
      "test.todo('g');",
      "it.concurrent.skip('h', () => hub);",
      "test.describe('i', () => hub);",
    ].join('\n'),
  });
  assert.equal(reachJson(root, 'src/hub.ts').tests, 5);
});

test('--files prints the shortest import chain to the module, or OK', (t) => {
  const root = checkout(t, {
    'src/hub.ts': 'export const hub = 1;\n',
    'src/mid.ts': "export { hub } from './hub.js';\n",
    'src/far.ts': "export { hub } from './mid.js';\n",
    'src/long.test.ts': "import { hub } from './far.js';\nimport { hub as h } from './mid.js';\ntest('a', () => [hub, h]);\n",
    'src/free.test.ts': "import type { X } from './hub.js';\n",
  });
  assert.equal(
    main(['src/hub.ts', '--files', 'src/long.test.ts', 'src/free.test.ts'], root),
    'src/long.test.ts: src/long.test.ts → src/mid.ts → src/hub.ts\nsrc/free.test.ts: OK (does not load src/hub.ts)',
  );
  assert.throws(() => main(['src/hub.ts', '--files', 'src/gone.test.ts'], root), /src\/gone\.test\.ts is not a file of this checkout/);
});

test('tsconfig comments and trailing commas parse, with comment markers inside strings kept', () => {
  assert.deepEqual(parseJsonc('{ /* a */ "p": ["./src/*", "//x"], // b\n }'), { p: ['./src/*', '//x'] });
});

test('an exports pattern maps its star, and a null entry blocks the subpath', () => {
  const exports = { '.': './src/index.ts', './*.test': null, './*': './src/*.ts' };
  assert.equal(matchExports(exports, './a/b'), './src/a/b.ts');
  assert.equal(matchExports(exports, './x.test'), null);
});
