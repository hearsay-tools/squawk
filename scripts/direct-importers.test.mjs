import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { directImporters, literalCandidates, stringLiterals } from './direct-importers.mjs';

function tree(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'direct-importers-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  return root;
}

test('an edited test file and a test that imports a changed file are direct; one reaching it through another module is not', t => {
  const root = tree(t, {
    'src/a.ts': 'export const a = 1;\n',
    'src/b.ts': "export { a } from './a.js';\n",
    'src/index.ts': "export * from './a';\n",
    'src/a.test.ts': "import { a } from './a.js';\n",
    'src/b.test.ts': "import { a } from './b.js';\n",
    'src/index.test.ts': "import { a } from './index';\n",
    'src/edited.test.ts': '// edited\n',
    'src/comment.test.ts': "// import { a } from './a.js';\nimport { a } from './b.js';\n",
  });
  const tests = ['src/a.test.ts', 'src/b.test.ts', 'src/index.test.ts', 'src/edited.test.ts', 'src/comment.test.ts'];
  assert.deepEqual(directImporters(root, tests, ['src/a.ts', 'src/edited.test.ts']), ['src/a.test.ts', 'src/edited.test.ts']);
});

test('a test that names a changed file or its directory as a path it reads is direct', t => {
  const root = tree(t, {
    'src/fixtures/run.ndjson': '{}\n',
    'src/reads.test.ts': "const p = new URL('fixtures/run.ndjson', import.meta.url);\n",
    'src/dir.test.ts': "const d = join(import.meta.dirname, 'fixtures');\n",
    'src/other.test.ts': "const p = 'nothing.txt';\n",
  });
  assert.deepEqual(directImporters(root, ['src/reads.test.ts', 'src/dir.test.ts', 'src/other.test.ts', 'src/gone.test.ts'], ['src/fixtures/run.ndjson']), ['src/reads.test.ts', 'src/dir.test.ts']);
});

test('a test that imports a module beside a same-name directory is direct when the module changes', t => {
  const root = tree(t, {
    'src/routes.tsx': 'export const routes = [];\n',
    'src/routes/home.tsx': 'export const home = 1;\n',
    'src/routes.test.tsx': "import { routes } from './routes';\n",
  });
  assert.deepEqual(directImporters(root, ['src/routes.test.tsx'], ['src/routes.tsx']), ['src/routes.test.tsx']);
});

test('a test that reads or imports a deleted changed file is direct', t => {
  const root = tree(t, {
    'src/reads.test.ts': "readFileSync(new URL('./fixtures/data.json', import.meta.url));\n",
    'src/imports.test.ts': "import { gone } from './gone.js';\n",
    'src/other.test.ts': "import { kept } from './kept.js';\n",
  });
  const deleted = ['src/fixtures/data.json', 'src/gone.ts'];
  assert.deepEqual(directImporters(root, ['src/reads.test.ts', 'src/imports.test.ts', 'src/other.test.ts'], deleted), ['src/reads.test.ts', 'src/imports.test.ts']);
});

test('a test that reads a directory whose last file was deleted is direct', t => {
  const root = tree(t, {
    'src/dir.test.ts': "readdirSync(new URL('./fixtures/', import.meta.url));\n",
    'src/root.test.ts': "const r = resolve(import.meta.dirname, '..');\n",
  });
  assert.deepEqual(directImporters(root, ['src/dir.test.ts', 'src/root.test.ts'], ['src/fixtures/last.json']), ['src/dir.test.ts']);
});

test('stringLiterals extracts quoted literals while ignoring comments and template expressions', () => {
  const text = [
    "import { browser } from './agent-browser' // the seam's 'helper'",
    "/* './commented.ts' */",
    "const data = resolve(import.meta.dirname, 'fixtures/run.ndjson')",
    'const url = `http://x/${id}`',
  ].join('\n');
  assert.deepEqual(stringLiterals(text), ['./agent-browser', 'fixtures/run.ndjson']);
});

test('literalCandidates resolves relative paths and workspace aliases and rejects invalid or external paths', () => {
  assert.ok(literalCandidates('packages/web/src/app.tsx', '@/lib/utils').includes('packages/web/src/lib/utils.ts'));
  assert.deepEqual(literalCandidates('packages/cezar/src/app.ts', '@/lib/utils').includes('packages/web/src/lib/utils.ts'), false);
  assert.ok(literalCandidates('packages/web/src/app.tsx', '@open-mercato/cezar-api-client').includes('packages/api-client/src/index.ts'));
  assert.ok(literalCandidates('packages/web/src/app.tsx', '@open-mercato/cezar-api-client/contract/defined').includes('packages/api-client/src/contract/defined.ts'));
  assert.ok(literalCandidates('packages/web/src/app.tsx', '@open-mercato/cezar-contract/schema.js').includes('packages/contract/src/schema.ts'));
  assert.deepEqual(literalCandidates('src/a.test.ts', '/etc/passwd'), []);
  assert.deepEqual(literalCandidates('src/a.test.ts', '../../outside'), []);
  assert.deepEqual(literalCandidates('src/a.test.ts', 'node_modules/pkg/index.js'), []);
  assert.deepEqual(literalCandidates('src/a.test.ts', 'node:fs'), []);
  assert.deepEqual(literalCandidates('src/a.test.ts', 'a few words'), []);
});

test('a test importing via workspace aliases is direct when the target file changes', t => {
  const root = tree(t, {
    'packages/web/src/lib/utils.ts': 'export const u = 1;\n',
    'packages/api-client/src/index.ts': 'export const client = 1;\n',
    'packages/web/src/app.test.tsx': "import { u } from '@/lib/utils';\n",
    'packages/web/src/api.test.tsx': "import { client } from '@open-mercato/cezar-api-client';\n",
  });
  assert.deepEqual(
    directImporters(root, ['packages/web/src/app.test.tsx', 'packages/web/src/api.test.tsx'], ['packages/web/src/lib/utils.ts']),
    ['packages/web/src/app.test.tsx'],
  );
  assert.deepEqual(
    directImporters(root, ['packages/web/src/app.test.tsx', 'packages/web/src/api.test.tsx'], ['packages/api-client/src/index.ts']),
    ['packages/web/src/api.test.tsx'],
  );
});
