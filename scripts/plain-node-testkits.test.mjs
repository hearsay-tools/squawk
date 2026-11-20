import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// Plain Node scripts load test kits: packages/cezar/scripts/parity-rows.ts, the benchmarks and
// .ai/scripts/mock-wire-evidence.ts among them. Vite's import.meta.glob exists only under Vitest,
// so a kit that used it broke those scripts while every Vitest test passed
// (hearsay-tools/squawk#3900). A kit reads a runner folder's data file with a folder template,
// `import(`../runners/${id}/facts.ts`)`, which both run (core/runner-data-rows.testkit.ts).
const REPO = fileURLToPath(new URL('..', import.meta.url));
const VITE_GLOB = /\bimport\.meta\.glob\s*[(<]/;

test('parity-rows.ts lists the parity rows under plain Node', () => {
  const rows = JSON.parse(execFileSync(process.execPath, ['packages/cezar/scripts/parity-rows.ts', '--json'], { cwd: REPO, encoding: 'utf8' }));
  assert.ok(rows.some(row => row.id === 'S1'), 'row S1 is listed');
  assert.ok(rows.length > 100, `${rows.length} rows`);
});

test('no module of the server package outside a test file calls import.meta.glob', () => {
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', 'packages/cezar/src', 'packages/cezar/scripts'], { cwd: REPO, encoding: 'utf8' })
    .split('\n').filter(file => /\.(?:[cm]?[jt]s)$/.test(file) && !/\.test\.[cm]?[jt]s$/.test(file));
  assert.ok(files.length > 100, `${files.length} files`);
  assert.deepEqual(files.filter(file => VITE_GLOB.test(readFileSync(join(REPO, file), 'utf8'))), []);
});
