'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { hasValidStatus, checkDirectory } = require('./check-spec-status.cjs');

test('accepts every status and a named superseding spec', () => {
  for (const status of ['draft', 'active', 'done', 'superseded', 'superseded by next.md']) {
    assert.equal(hasValidStatus(`# Design\r\nStatus: ${status}\r\n\r\nBody`), true);
  }
});

test('rejects missing, displaced, malformed and unknown status lines', () => {
  for (const source of ['# Design', '# Design\n\nStatus: done', '# Design\nStatus: implemented',
    '# Design\nStatus: done extra', '# Design\nStatus: superseded by ', 'Status: done',
    '# Design\nStatus: superseded by next', '# Design\n> Status: done']) {
    assert.equal(hasValidStatus(source), false, source);
  }
});

test('checks only Markdown files directly in the spec directory', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'spec-status-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, 'valid.md'), '# Design\nStatus: draft\n');
  writeFileSync(join(directory, 'missing.md'), '# Design\n');
  writeFileSync(join(directory, 'image.svg'), '<svg/>');
  mkdirSync(join(directory, 'assets'));
  writeFileSync(join(directory, 'assets', 'nested.md'), '# Asset');
  assert.deepEqual(checkDirectory(directory), [join(directory, 'missing.md')]);
});
