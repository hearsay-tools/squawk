const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync, existsSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');

const reporterUrl = pathToFileURL(join(__dirname, 'vitest-file-duration.mjs')).href;
// Failure fixtures must not publish synthetic cap failures to a real Actions job summary or read
// a real changed-file list; tests that need either set it themselves.
delete process.env.GITHUB_STEP_SUMMARY;
delete process.env.VITEST_CHANGED_FILES;

async function reporter(options = {}) {
  const { default: Reporter } = await import(reporterUrl);
  const instance = new Reporter({ durations: {}, changedFilesList: undefined, ...options });
  instance.root = '/repo';
  await instance.onTestRunStart();
  return instance;
}

function moduleResult(duration, state = 'passed', file = 'hooks.test.ts') {
  return { project: { name: 'server' }, moduleId: `/repo/${file}`, state: () => state, diagnostic: () => ({ duration }) };
}

function end(instance, ...modules) {
  for (const module of modules) {
    instance.onTestModuleCollected(module);
    instance.onTestModuleEnd(module);
  }
  return instance;
}

async function completed(duration, options) {
  return end(await reporter(options), moduleResult(duration));
}

function finish(instance) {
  const previous = process.exitCode;
  const output = { error: [], warn: [], log: [] };
  const mocks = ['error', 'warn', 'log'].map(level => mock.method(console, level, message => output[level].push(message)));
  try {
    process.exitCode = 0;
    instance.onTestRunEnd();
    return { exitCode: process.exitCode, output: output.error.join('\n'), warnings: output.warn.join('\n'), annotations: output.log };
  } finally {
    for (const item of mocks) item.mock.restore();
    process.exitCode = previous;
  }
}

function assertFailure(instance, pattern) {
  const result = finish(instance);
  assert.equal(result.exitCode, 1);
  assert.match(result.output, pattern);
  return result;
}

function changedList(t, files) {
  const dir = mkdtempSync(join(tmpdir(), 'cap-changed-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'changed.txt'), files.map(file => `${file}\n`).join(''));
  return join(dir, 'changed.txt');
}

test('59,999 ms passes while exactly 60,000 ms fails', async () => {
  const below = await completed(59_999);
  assert.equal(finish(below).exitCode, 0);
  const boundary = await completed(60_000);
  assertFailure(boundary, /^Vitest file duration cap failed:\nhooks\.test\.ts: 60000 ms \(60000 ms at shard slowdown x1\.00\); hard limit 60000 ms \(FILE_DURATION_LIMIT_MS in \.github\/scripts\/vitest-file-duration\.mjs\)$/);
});

test('a failed file gets an error annotation naming the file and the limit', async () => {
  const result = assertFailure(await completed(60_001), /hooks\.test\.ts: 60001 ms/);
  assert.deepEqual(result.annotations, [
    '::error file=hooks.test.ts,title=Vitest file duration cap::hooks.test.ts: 60001 ms (60001 ms at shard slowdown x1.00); hard limit 60000 ms (FILE_DURATION_LIMIT_MS in .github/scripts/vitest-file-duration.mjs)',
  ]);
});

test('the step summary carries the cap line when Actions provides one', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'cap-summary-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const summary = join(dir, 'summary.md');
  process.env.GITHUB_STEP_SUMMARY = summary;
  t.after(() => { delete process.env.GITHUB_STEP_SUMMARY; });
  assertFailure(await completed(61_000), /hooks\.test\.ts/);
  assert.match(readFileSync(summary, 'utf8'), /^### Vitest file duration cap failed\n\n- hooks\.test\.ts: 61000 ms .*hard limit 60000 ms/);
});

test('without a changed-file list the soft limit is off', async () => {
  assert.deepEqual(finish(await completed(59_999)).exitCode, 0);
});

test('every shard warns at 80% of the hard cap without failing', async () => {
  assert.deepEqual(finish(await completed(47_999)), { exitCode: 0, output: '', warnings: '', annotations: [] });
  const warning = finish(await completed(48_000));
  assert.equal(warning.exitCode, 0);
  assert.equal(warning.output, '');
  assert.match(warning.warnings, /hooks\.test\.ts: 48000 ms .*warning threshold 48000 ms \(80% of hard limit 60000 ms/);
  assert.equal(warning.annotations.length, 1);
  assert.match(warning.annotations[0], /^::warning file=hooks\.test\.ts,/);
});

test('the warning uses the shard-scaled duration', async () => {
  const durations = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`f${index}.test.ts`, 1000]));
  const shard = () => Array.from({ length: 10 }, (_, index) => moduleResult(2000, 'passed', `f${index}.test.ts`));
  const below = finish(end(await reporter({ durations }), ...shard(), moduleResult(95_998)));
  assert.equal(below.warnings, '');
  const at = finish(end(await reporter({ durations }), ...shard(), moduleResult(96_000)));
  assert.equal(at.exitCode, 0);
  assert.match(at.warnings, /96000 ms \(48000 ms at shard slowdown x2\.00\).*warning threshold 48000 ms/);
});

test('the soft limit fails a file the PR changes and warns for any other file', async t => {
  const list = changedList(t, ['hooks.test.ts']);
  assert.equal(finish(await completed(44_999, { changedFilesList: list })).exitCode, 0);
  const changed = assertFailure(await completed(45_000, { changedFilesList: list }),
    /hooks\.test\.ts: 45000 ms .*; soft limit 45000 ms \(FILE_DURATION_SOFT_LIMIT_MS in \.github\/scripts\/vitest-file-duration\.mjs\); the PR changes this file/);
  assert.match(changed.annotations[0], /^::error file=hooks\.test\.ts,/);

  const other = finish(end(await reporter({ changedFilesList: list }), moduleResult(50_000, 'passed', 'other.test.ts')));
  assert.equal(other.exitCode, 0);
  assert.match(other.warnings, /other\.test\.ts: 50000 ms .*soft limit 45000 ms.*warning only: the PR does not change this file/);
  assert.match(other.annotations[0], /^::warning file=other\.test\.ts,title=Vitest file duration cap::other\.test\.ts: 50000 ms/);
});

test('annotation properties and data are escaped as workflow commands', async () => {
  const result = finish(end(await reporter(), moduleResult(60_000, 'passed', 'a,b:c%.test.ts')));
  assert.match(result.annotations[0], /^::error file=a%2Cb%3Ac%25\.test\.ts,title=Vitest file duration cap::a,b:c%25\.test\.ts: /);
});

test('shard slowdown is the clamped median of measured over manifest weight', async () => {
  const { shardSlowdown, SLOWDOWN_MIN_FILES } = await import(reporterUrl);
  const weights = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`f${index}.test.ts`, 1000]));
  const measure = factors => factors.map((factor, index) => ({ file: `f${index}.test.ts`, duration: 1000 * factor }));
  assert.equal(shardSlowdown(measure(Array(SLOWDOWN_MIN_FILES - 1).fill(2)), weights), 1, 'too few weighted files');
  assert.equal(shardSlowdown(measure(Array(SLOWDOWN_MIN_FILES).fill(2)), weights), 2);
  assert.equal(shardSlowdown(measure([1, 1, 1, 1, 1, 2, 3, 3, 3, 3, 3, 3]), weights), 2.5, 'even count averages the middle pair');
  assert.equal(shardSlowdown(measure(Array(11).fill(0.5)), weights), 1, 'a fast shard never tightens the cap');
  assert.equal(shardSlowdown(measure(Array(11).fill(9)), weights), 3, 'a broken shard cannot hide everything');
  assert.equal(shardSlowdown([...measure(Array(9).fill(2)), { file: 'unweighted.test.ts', duration: 5000 }], weights), 1, 'unweighted files do not count');
});

test('a slow shard passes a file under the cap after scaling, a normal shard still fails it', async () => {
  const durations = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`f${index}.test.ts`, 1000]));
  durations['near.test.ts'] = 50_000;
  const shard = factor => [...Array.from({ length: 10 }, (_, index) => moduleResult(1000 * factor, 'passed', `f${index}.test.ts`))];
  const slow = finish(end(await reporter({ durations }), ...shard(2.1), moduleResult(105_000, 'passed', 'near.test.ts')));
  assert.equal(slow.exitCode, 0, slow.output);
  const normal = end(await reporter({ durations }), ...shard(1), moduleResult(61_000, 'passed', 'near.test.ts'));
  assertFailure(normal, /near\.test\.ts: 61000 ms \(61000 ms at shard slowdown x1\.00\); hard limit/);
});

test('the manifest supplies the weights when none are given', async () => {
  const { default: Reporter } = await import(reporterUrl);
  const instance = new Reporter({ changedFilesList: undefined });
  instance.root = '/repo';
  await instance.onTestRunStart();
  assert.equal(finish(end(instance, moduleResult(1))).exitCode, 0);
});

test('a collected module without completion fails instead of passing with zero duration', async () => {
  const instance = await reporter();
  instance.onTestModuleCollected(moduleResult(0, 'pending'));
  assertFailure(instance, /^Vitest test files that did not finish:\nhooks\.test\.ts: did not finish; the run ended before the file reported a result$/);
});

test('a planned file that never reports a result is named, annotated and listed for the rerun', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'cap-unfinished-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { default: Reporter } = await import(reporterUrl);
  const instance = new Reporter({ durations: {}, changedFilesList: undefined });
  instance.onInit({ config: { root: dir } });
  const spec = file => ({ project: { name: 'server' }, moduleId: join(dir, file) });
  await instance.onTestRunStart([spec('done.test.ts'), spec('dies.test.ts')]);
  end(instance, { ...moduleResult(10, 'passed'), moduleId: join(dir, 'done.test.ts') });
  const result = assertFailure(instance, /^Vitest test files that did not finish:\ndies\.test\.ts: did not finish; the run ended before the file reported a result$/);
  assert.deepEqual(result.annotations, [
    '::error file=dies.test.ts,title=Vitest test files that did not finish::dies.test.ts: did not finish; the run ended before the file reported a result',
  ]);
  assert.equal(readFileSync(join(dir, 'node_modules/.vite/vitest/file-duration-cap.txt'), 'utf8'), `${join(dir, 'dies.test.ts')}\n`);
});

test('a sharded run plans only the files the configured sequencer gives its shard', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'cap-shard-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { default: Reporter } = await import(reporterUrl);
  const instance = new Reporter({ durations: {}, changedFilesList: undefined });
  class Sequencer {
    constructor(ctx) { assert.equal(ctx, vitest); }
    async shard(specifications) { return specifications.filter(item => item.moduleId.endsWith('mine.test.ts')); }
  }
  const vitest = { config: { root: dir, shard: { index: 1, count: 2 }, sequence: { sequencer: Sequencer } } };
  instance.onInit(vitest);
  const spec = file => ({ project: { name: 'server' }, moduleId: join(dir, file) });
  await instance.onTestRunStart([spec('mine.test.ts'), spec('other-shard.test.ts')]);
  assertFailure(instance, /^Vitest test files that did not finish:\nmine\.test\.ts: did not finish/);
});

test('a Vitest worker that exits on its own is reported with its exit code and signal', async () => {
  const { channel } = require('node:diagnostics_channel');
  const { EventEmitter } = require('node:events');
  const { watchWorkerExits } = await import(reporterUrl);
  const exits = [];
  watchWorkerExits(exit => exits.push(exit));
  const child = (pid, script, killed = false) => Object.assign(new EventEmitter(), { pid, killed, spawnargs: ['node', script] });
  const children = [
    child(1, '/n/vitest/dist/workers/forks.js'),
    child(2, '/n/vitest/dist/workers/forks.js', true),
    child(3, '/n/other/child.js'),
  ];
  for (const item of children) channel('child_process').publish({ process: item });
  for (const item of children) item.emit('exit', null, 'SIGKILL');
  assert.deepEqual(exits, [{ pid: 1, code: null, signal: 'SIGKILL' }]);

  const instance = await reporter();
  instance.exits.push(exits[0], { pid: 4, code: 134, signal: null });
  const result = finish(instance);
  assert.equal(result.exitCode, 0, 'a worker exit alone leaves the verdict to Vitest');
  assert.equal(result.output, 'Vitest test files that did not finish:\n'
    + 'Vitest worker 1 exited unexpectedly: exit code null, signal SIGKILL\nVitest worker 4 exited unexpectedly: exit code 134, signal none');
});

test('a real sharded Vitest run passes every shard whose files all finish', () => {
  const root = resolve(__dirname, '../..');
  mkdirSync(join(root, '.ai/qa'), { recursive: true });
  const probe = mkdtempSync(join(root, '.ai/qa/vitest-shard-'));
  try {
    for (const name of ['a', 'b', 'c']) writeFileSync(join(probe, `${name}.test.ts`), `import { test, expect } from 'vitest'
test('passes', () => expect(1).toBe(1))
`);
    writeFileSync(join(probe, 'vitest.config.mjs'), `import { defineConfig } from 'vitest/config'
import Reporter from ${JSON.stringify(reporterUrl)}
export default defineConfig({ test: { include: ['*.test.ts'], reporters: ['default', new Reporter()] } })
`);
    for (const shard of ['1/2', '2/2']) {
      const result = spawnSync(join(root, 'node_modules/.bin/vitest'), ['run', '--config', join(probe, 'vitest.config.mjs'), `--shard=${shard}`], { cwd: probe, encoding: 'utf8' });
      const output = result.stdout + result.stderr;
      assert.equal(result.status, 0, output);
      assert.doesNotMatch(output, /did not finish/);
    }
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
});

test('a real Vitest run names the file whose worker died and the signal that ended it', () => {
  const root = resolve(__dirname, '../..');
  mkdirSync(join(root, '.ai/qa'), { recursive: true });
  const probe = mkdtempSync(join(root, '.ai/qa/vitest-unfinished-'));
  try {
    writeFileSync(join(probe, 'passes.test.ts'), `import { test, expect } from 'vitest'
test('passes', () => expect(1).toBe(1))
`);
    // The worker dies while it imports the file, before Vitest collects any test of it.
    writeFileSync(join(probe, 'dies.test.ts'), `import { test } from 'vitest'
process.kill(process.pid, 'SIGKILL')
test('never runs', () => {})
`);
    writeFileSync(join(probe, 'vitest.config.mjs'), `import { defineConfig } from 'vitest/config'
import Reporter from ${JSON.stringify(reporterUrl)}
export default defineConfig({ test: { include: ['*.test.ts'], reporters: ['default', new Reporter()] } })
`);
    const result = spawnSync(join(root, 'node_modules/.bin/vitest'), ['run', '--config', join(probe, 'vitest.config.mjs')], { cwd: probe, encoding: 'utf8' });
    const output = result.stdout + result.stderr;
    assert.equal(result.status, 1, output);
    assert.match(output, /Vitest test files that did not finish:\ndies\.test\.ts: did not finish; the run ended before the file reported a result\nVitest worker \d+ exited unexpectedly: exit code null, signal SIGKILL\n/);
    assert.equal((output.match(/exited unexpectedly: exit code/g) ?? []).length, 1, 'workers Vitest stopped itself are not reported');
    // The merge-group rerun reset reads this list to name the file in the flake report.
    assert.equal(readFileSync(join(probe, 'node_modules/.vite/vitest/file-duration-cap.txt'), 'utf8'), `${join(probe, 'dies.test.ts')}\n`);
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
});

test('an end event without a completed state or valid measurement fails', async () => {
  for (const [duration, state] of [[0, 'pending'], [NaN, 'passed'], [Infinity, 'passed'], [-1, 'passed']]) {
    const instance = await reporter();
    instance.onTestModuleEnd(moduleResult(duration, state));
    assertFailure(instance, /no completed result/);
  }
});

test('the cap fails a real coverage-enabled Vitest run after module teardown', () => {
  const root = resolve(__dirname, '../..');
  mkdirSync(join(root, '.ai/qa'), { recursive: true });
  const probe = mkdtempSync(join(root, '.ai/qa/vitest-cap-'));
  try {
    writeFileSync(join(probe, 'one.test.ts'), `import { test, afterAll, expect } from 'vitest'
import { writeFileSync } from 'node:fs'
afterAll(() => writeFileSync(${JSON.stringify(join(probe, 'teardown'))}, 'done'))
test('passes', () => expect(1).toBe(1))
`);
    writeFileSync(join(probe, 'vitest.config.mjs'), `import { defineConfig } from 'vitest/config'
import { existsSync } from 'node:fs'
import Reporter from ${JSON.stringify(reporterUrl)}
// Set the completed module clock without making this regression take a minute.
const clock = { onTestModuleEnd(module) {
  if (!existsSync(${JSON.stringify(join(probe, 'teardown'))})) throw new Error('teardown did not run')
  module.task.result.duration = Number(process.env.PROBE_DURATION)
} }
export default defineConfig({ test: {
  include: ['one.test.ts'], maxWorkers: 1, reporters: ['default', clock, new Reporter()],
  coverage: { provider: 'v8', reporter: ['json'], reportsDirectory: './coverage' },
} })
`);
    for (const [duration, expected] of [[59_999, 0], [60_000, 1]]) {
      rmSync(join(probe, 'teardown'), { force: true });
      rmSync(join(probe, 'coverage'), { recursive: true, force: true });
      const result = spawnSync(join(root, 'node_modules/.bin/vitest'), ['run', '--config', join(probe, 'vitest.config.mjs'), '--coverage.enabled'], {
        cwd: probe, encoding: 'utf8', env: { ...process.env, PROBE_DURATION: String(duration) },
      });
      const output = result.stdout + result.stderr;
      assert.equal(result.status, expected, output);
      if (expected) assert.match(output, /one\.test\.ts: 60000 ms \(60000 ms at shard slowdown x1\.00\); hard limit 60000 ms/);
      // The merge-group rerun reset reads this list to name the file in the flake report.
      const list = join(probe, 'node_modules/.vite/vitest/file-duration-cap.txt');
      assert.equal(existsSync(list) && readFileSync(list, 'utf8'), expected ? `${join(probe, 'one.test.ts')}\n` : false);
      assert.ok(existsSync(join(probe, 'coverage/coverage-final.json')), 'coverage artifact missing');
    }
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
});

test('only the CI shard step enables the cap and the root config appends it', () => {
  const yaml = require('yaml');
  const root = resolve(__dirname, '../..');
  const workflow = yaml.parse(readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8'));
  const step = workflow.jobs.vitest.steps.find(step => step.name === 'Run server and cockpit unit suites');
  assert.equal(step.env.VITEST_FILE_DURATION_CAP, '1');
  assert.match(step.run, /--shard=.*matrix.shard/);
  const config = readFileSync(join(root, 'vitest.config.ts'), 'utf8');
  assert.match(config, /process\.env\.VITEST_FILE_DURATION_CAP === '1' \? \[new FileDurationReporter\(\)\] : \[\]/);
  assert.equal((config.match(/'github-actions'/g) ?? []).length, 1);
});
