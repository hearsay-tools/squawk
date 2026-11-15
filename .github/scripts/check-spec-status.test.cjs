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

test('ignores a heading and status inside an HTML comment or a code fence', () => {
  for (const source of [
    '<!-- # Example\nStatus: done -->\nBody',
    '<!--\n# Example\nStatus: done\n-->\nBody',
    '<!-- note --> <!--\n# Example\nStatus: done\n-->\nBody',
    '```md\n# Example\nStatus: done\n```\nBody',
    '~~~\n# Example\nStatus: done\n~~~\nBody',
    '````\n```\n# Example\nStatus: done\n```\n````\nBody',
    '```\n# Example\nStatus: done\n~~~\nBody',
    '<!-- unclosed\n# Example\nStatus: done\n',
  ]) {
    assert.equal(hasValidStatus(source), false, source);
  }
});

test('finds the real title after a commented or fenced decoy', () => {
  for (const source of [
    '<!-- # Example\nStatus: draft -->\n# Design\nStatus: done\n',
    '<!-- one --><!-- two -->\n# Design\nStatus: done\n',
    '<!--\n# Example\n-->\n# Design\nStatus: done\n',
    '```\n# Example\n```\n# Design\nStatus: done\n',
    '~~~~\n~~~\n# Example\n~~~~\n# Design\nStatus: done\n',
  ]) {
    assert.equal(hasValidStatus(source), true, source);
  }
});

test('every current spec passes', () => {
  assert.deepEqual(checkDirectory(join(__dirname, '../../.ai/specs')), []);
});

test('a fence opener or a title that opens a comment hides what follows', () => {
  assert.equal(hasValidStatus('```html <!--\n```\n# Design\nStatus: done\n'), true);
  assert.equal(hasValidStatus('# Design <!--\nStatus: done\n-->\n'), false);
});
