import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { directImporters } from './direct-importers.mjs';

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
