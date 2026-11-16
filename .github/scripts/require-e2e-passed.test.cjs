const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const script = path.join(__dirname, 'require-e2e-passed.cjs');

function evaluate(output, event = 'merge_group') {
  assert.equal(fs.existsSync(script), true, 'CI must gate TEST_E2E_STATUS through require-e2e-passed.cjs');
  return spawnSync(process.execPath, [script], {
    env: { ...process.env, GITHUB_EVENT_NAME: event },
    encoding: 'utf8',
    input: output,
  });
}

test('CI accepts only TEST_E2E_STATUS=passed', () => {
  const result = evaluate('vitest ok\nTEST_E2E_STATUS=passed\n');
  assert.equal(result.status, 0, result.stderr);
});

test('CI rejects TEST_E2E_STATUS=skipped even when the suite exits 0', () => {
  const result = evaluate('E2E SKIPPED — the UI was NOT verified.\nTEST_E2E_STATUS=skipped\n');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /skipped/);
});

test('CI rejects TEST_E2E_STATUS=failed', () => {
  const result = evaluate('a spec failed\nTEST_E2E_STATUS=failed\n');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /failed/);
});

test('CI rejects a run that never printed TEST_E2E_STATUS', () => {
  const result = evaluate('vitest crashed before the marker\n');
  assert.notEqual(result.status, 0);
});

test('CI reads the last TEST_E2E_STATUS when the log contains more than one', () => {
  const passedThenSkipped = evaluate('TEST_E2E_STATUS=passed\nTEST_E2E_STATUS=skipped\n');
  assert.notEqual(passedThenSkipped.status, 0);
  const skippedThenPassed = evaluate('TEST_E2E_STATUS=skipped\nTEST_E2E_STATUS=passed\n');
  assert.equal(skippedThenPassed.status, 0, skippedThenPassed.stderr);
});

test('CI accepts TEST_E2E_STATUS=not-selected only on a pull_request_target run', () => {
  const log = '[e2e:affected] PR CI runs no browser spec: the selector chose every spec.\nTEST_E2E_STATUS=not-selected\n';
  for (const event of ['merge_group', 'push', 'workflow_dispatch', 'schedule', '']) {
    const strict = evaluate(log, event);
    assert.notEqual(strict.status, 0, event);
    assert.match(strict.stderr, /not-selected/);
  }
  assert.equal(evaluate(log, 'pull_request_target').status, 0);
  assert.notEqual(evaluate('TEST_E2E_STATUS=skipped\n', 'pull_request_target').status, 0);
  assert.notEqual(evaluate('TEST_E2E_STATUS=failed\n', 'pull_request_target').status, 0);
});
