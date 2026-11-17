import assert from 'node:assert/strict';
import test from 'node:test';
import { proposeWorkflowName } from '../../src/planner.js';

test('proposeWorkflowName slugs a title to the file-name form', () => {
  assert.equal(proposeWorkflowName('Fix And Review'), 'fix-and-review');
  assert.equal(proposeWorkflowName('  Ship it!  '), 'ship-it');
  assert.equal(proposeWorkflowName('already-kebab'), 'already-kebab');
});

test('proposeWorkflowName degrades a blank / slug-less title to undefined', () => {
  // The caller keeps the current name rather than blanking it when nothing survives.
  assert.equal(proposeWorkflowName(undefined), undefined);
  assert.equal(proposeWorkflowName('   '), undefined);
  assert.equal(proposeWorkflowName('!!! ???'), undefined);
});
