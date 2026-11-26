'use strict';

// Guards Squeal shared results (hearsay-tools/squeal spec 018 D17): merge-group Vitest shards run
// their unchanged command under `squeal ci record`, and an optional job publishes refs/squeal/<sha>.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { runInNewContext } = require('node:vm');
const yaml = require('yaml');

const repoRoot = path.join(__dirname, '..', '..');
const ci = () => yaml.parse(fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8'));
const EVENTS = ['pull_request_target', 'workflow_dispatch', 'merge_group', 'push'];
const step = (job, id) => job.steps.find((s) => s.id === id || s.name === id);
// Squeal's GitHub Action (hearsay-tools/squeal spec 018 D20) puts `squeal` on the PATH and never
// fails the job. Like every action here it is pinned to a full commit SHA; the comment names its
// release tag.
const SQUEAL_ACTION = 'hearsay-tools/squeal/ci@846c3a8069d2941eb5e63f590fd11047442202eb';
const SQUEAL_PIN = `uses: ${SQUEAL_ACTION} # v0.1.641`;

function expression(raw, context) {
  const code = String(raw).replace(/^\$\{\{\s*|\s*\}\}$/g, '').replace(/needs\.([\w]+-[\w-]+)/g, "needs['$1']");
  return runInNewContext(code, context);
}

function context(event, { vitest = 'success', browser = 'success', exported = 'success', results = 'true', pr = '', steps = {} } = {}) {
  return {
    github: { event_name: event },
    inputs: { pr_number: pr },
    needs: {
      vitest: { result: vitest },
      'cockpit-browser': { result: browser },
      'squeal-export': { result: exported, outputs: { results } },
    },
    steps,
    cancelled: () => false,
  };
}

// The step's script with its expressions resolved for one shard of one event.
function script(run, event, shard) {
  return run.replace(/\$\{\{.*?\}\}/g, (raw) => raw.includes('matrix.shard') && !raw.includes('&&') ? String(shard) : expression(raw, context(event)));
}

test('the Vitest shards and the Squeal jobs read one exact Node version from .node-version', () => {
  const version = fs.readFileSync(path.join(repoRoot, '.node-version'), 'utf8');
  assert.match(version, /^\d+\.\d+\.\d+\n$/, 'one exact version, no range or alias');
  const [major, minor] = version.split('.').map(Number);
  const floor = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).engines.node.slice(2).split('.').map(Number);
  assert.ok(major > floor[0] || (major === floor[0] && minor >= floor[1]), 'at or above the engines floor');
  const { jobs } = ci();
  const readers = Object.entries(jobs).filter(([, job]) => (job.steps ?? []).some((s) => s.with?.['node-version-file']))
    .map(([id]) => id);
  assert.deepEqual(readers.sort(), ['cockpit-browser', 'crap-report', 'prepare-pr-snapshot', 'publish-snapshot', 'squeal-export', 'squeal-node-test', 'squeal-publish', 'vitest',
    'vitest-coverage-merge'], 'the minimum-Node jobs keep engines.node');
  for (const id of readers) {
    const setup = jobs[id].steps.find((s) => s.uses?.startsWith('actions/setup-node@'));
    assert.equal(setup.with['node-version-file'], '.node-version', id);
    assert.equal(setup.with['node-version'], undefined, id);
  }
});

test('only merge groups run the shard under squeal ci record; every other run as before', () => {
  const vitest = ci().jobs.vitest;
  const collect = step(vitest, 'collect');
  const record = step(vitest, 'record');
  const recorded = ['Set up Squeal', 'record', 'Upload Squeal parts'].map((id) => step(vitest, id));
  const runs = EVENTS.map((event) => [event, {}, event === 'merge_group']);
  for (const [event, inputs, recording] of runs) {
    const ctx = context(event, inputs);
    const name = `${event} ${JSON.stringify(inputs)}`;
    assert.equal(expression(collect.if, ctx), event !== 'pull_request_target' && !recording, `${name} collect`);
    for (const s of recorded) assert.equal(expression(s.if, ctx), recording, `${name} ${s.name}`);
  }
  assert.equal(record.env.VITEST_FILE_DURATION_CAP, collect.env.VITEST_FILE_DURATION_CAP);
  // Test failures block: a merge group continues past them only to its rerun, which blocks
  // (ci-queue-rerun.workflow.test.cjs).
  for (const [event, inputs] of runs) {
    assert.equal(expression(record['continue-on-error'], context(event, inputs)), event === 'merge_group', `${event} ${JSON.stringify(inputs)}`);
  }
  assert.equal(step(vitest, 'Set up Squeal').uses, SQUEAL_ACTION);
  // The recorded command is the shard command without its own V8 coverage, which only the plain
  // command adds: Squeal's provider yields to a project's coverage (squeal spec 020 D13.1).
  const command = record.run.split('\n')[0];
  const COVERAGE = " ${{ (github.event_name == 'pull_request_target' || github.event_name == 'workflow_dispatch') && '--coverage.enabled' || '' }}";
  assert.equal(command, 'set -- npm test -- --shard=${{ matrix.shard }}/8 --maxWorkers=4');
  assert.equal(`set -- ${collect.run}`, `${command}${COVERAGE}`);
  const upload = step(vitest, 'Upload Squeal parts');
  assert.equal(upload['continue-on-error'], true);
  assert.equal(upload.with.name, 'squeal-parts-shard-${{ matrix.shard }}');
  // The first run's parts, unless a merge-group rerun recorded its own (ci-queue-rerun.workflow.test.cjs).
  assert.equal(upload.with.path, "${{ runner.temp }}/${{ steps.rerun.outcome == 'skipped' && 'squeal-parts' || 'squeal-parts-rerun' }}/");
  assert.equal(record.env.PARTS_DIR, 'squeal-parts');
  assert.equal(upload.with['retention-days'], 3);
  // A shard whose tests failed still uploads its parts: the condition carries its own status
  // function, so GitHub adds no success() (cezarion#3264 review). It reads no setup step: when
  // Squeal cannot run, the action passes the command through and there are no parts to upload.
  assert.doesNotMatch(upload.if, /steps\./);
  assert.match(String(upload.if), /^!cancelled\(\) && /);
});

test('the merge-group step runs the test command under squeal ci record and returns its exit code and output', () => {
  const record = step(ci().jobs.vitest, 'record');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-squeal-record-'));
  try {
    const bin = path.join(temp, 'bin');
    fs.mkdirSync(bin);
    // `squeal ci record` returns the command's code, as the action's pass-through does when Squeal cannot run.
    fs.writeFileSync(path.join(bin, 'squeal'), '#!/bin/sh\necho "squeal $*"\nwhile [ "$1" != -- ]; do shift; done\nshift\nexec "$@"\n', { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\necho "npm $*"\nexit 3\n', { mode: 0o755 });
    const run = (event) => spawnSync('bash', ['-e', '-c', script(record.run, event, 2)], {
      encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin`, RUNNER_TEMP: '/runner/temp', PARTS_DIR: record.env.PARTS_DIR },
    });
    const recorded = run('merge_group');
    assert.equal(recorded.status, 3, 'the step\'s exit code is the command\'s');
    assert.equal(recorded.stdout, 'squeal ci record --out /runner/temp/squeal-parts -- npm test -- --shard=2/8 --maxWorkers=4\n'
      + 'npm test -- --shard=2/8 --maxWorkers=4\n');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('only merge groups run cockpit browser shards under squeal ci record after test-env-up.sh; other events run unchanged', () => {
  const browser = ci().jobs['cockpit-browser'];
  const e2e = step(browser, 'e2e');
  const setup = step(browser, 'Set up Squeal');
  const upload = step(browser, 'Upload Squeal parts');
  assert.equal(setup.uses, SQUEAL_ACTION);
  for (const event of EVENTS) {
    const ctx = context(event);
    const recording = event === 'merge_group';
    assert.equal(expression(setup.if, ctx), recording, `${event} Set up Squeal`);
    assert.equal(expression(upload.if, ctx), recording, `${event} Upload Squeal parts`);
    assert.equal(expression(e2e.env.PARTS_DIR, ctx), recording ? 'squeal-parts-browser' : '', `${event} PARTS_DIR`);
  }
  assert.equal(upload['continue-on-error'], true);
  assert.equal(upload.with.name, 'squeal-parts-browser-shard-${{ matrix.shard }}');
  assert.equal(upload.with.path, "${{ runner.temp }}/${{ steps['e2e-rerun'].outcome == 'skipped' && 'squeal-parts-browser' || 'squeal-parts-browser-rerun' }}/");
  assert.equal(upload.with['retention-days'], 3);
  assert.doesNotMatch(upload.if, /steps\./);
  assert.match(String(upload.if), /^!cancelled\(\) && /);

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-squeal-browser-'));
  try {
    const bin = path.join(temp, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'squeal'), '#!/bin/sh\necho "squeal $*"\nwhile [ "$1" != -- ]; do shift; done\nshift\nexec "$@"\n', { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\necho "npm $*"\necho "TEST_E2E_STATUS=passed"\nexit "${NPM_EXIT:-0}"\n', { mode: 0o755 });
    fs.mkdirSync(path.join(temp, '.ai', 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(temp, '.ai', 'scripts', 'test-env-up.sh'), 'echo "test-env-up"\n');
    fs.mkdirSync(path.join(temp, '.github', 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(temp, '.github', 'scripts', 'require-e2e-passed.cjs'), 'const s = require("fs").readFileSync(0, "utf8"); console.log("require:" + s.includes("TEST_E2E_STATUS=passed"));\n');
    const run = (event, extraEnv = {}) => spawnSync('bash', ['-e', '-c', e2e.run.replaceAll('${{ matrix.shard }}', '3')], {
      cwd: temp, encoding: 'utf8',
      env: { PATH: `${bin}:/usr/bin:/bin:${path.dirname(process.execPath)}`, RUNNER_TEMP: '/runner/temp', PARTS_DIR: expression(e2e.env.PARTS_DIR, context(event)), ...extraEnv },
    });
    const plain = run('push');
    assert.equal(plain.status, 0, plain.stderr);
    assert.equal(plain.stdout, 'npm run test:e2e -- --allow-skip --shard=3/8\nTEST_E2E_STATUS=passed\nrequire:true\n');
    const recorded = run('merge_group');
    assert.equal(recorded.status, 0, recorded.stderr);
    assert.equal(recorded.stdout, 'test-env-up\nsqueal ci record --out /runner/temp/squeal-parts-browser -- npm run test:e2e -- --allow-skip --shard=3/8\nnpm run test:e2e -- --allow-skip --shard=3/8\nTEST_E2E_STATUS=passed\nrequire:true\n');
    const failed = run('merge_group', { NPM_EXIT: '4' });
    assert.equal(failed.status, 4, 'pipefail preserves the recorded browser command exit code');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

const SQUEAL_JOBS = ['squeal-export', 'squeal-node-test', 'squeal-publish'];

test('squeal-export runs after passing merge-group shards and only reads', () => {
  const { jobs, permissions } = ci();
  const job = jobs['squeal-export'];
  // It waits for the node:test recording and browser shards, but runs without them: only the Vitest shards decide.
  assert.deepEqual(job.needs, ['vitest', 'squeal-node-test', 'cockpit-browser']);
  assert.doesNotMatch(job.if, /squeal-node-test|cockpit-browser/);
  for (const event of EVENTS) assert.equal(expression(job.if, context(event)), event === 'merge_group', event);
  for (const vitest of ['failure', 'skipped', 'cancelled']) assert.equal(expression(job.if, context('merge_group', { vitest })), false, vitest);
  for (const browser of ['success', 'failure', 'skipped', 'cancelled']) assert.equal(expression(job.if, context('merge_group', { browser })), true, `browser ${browser}`);
  assert.deepEqual(job.permissions, { contents: 'read' });
  assert.deepEqual(permissions, { contents: 'read' });
  const checkout = job.steps.find((s) => s.uses?.startsWith('actions/checkout@'));
  assert.equal(checkout.with.ref, '${{ github.event.merge_group.head_sha }}');
  assert.equal(checkout.with['persist-credentials'], false);
});

test('squeal-publish alone writes contents, after the export, and runs no repository code', () => {
  const { jobs } = ci();
  const job = jobs['squeal-publish'];
  assert.deepEqual(job.needs, ['squeal-export']);
  for (const event of EVENTS) assert.equal(expression(job.if, context(event)), event === 'merge_group', event);
  for (const exported of ['failure', 'skipped', 'cancelled']) {
    assert.equal(expression(job.if, context('merge_group', { exported })), false, exported);
  }
  // An export that wrote no file passes its job; the publish then has nothing to push.
  for (const results of ['false', '']) assert.equal(expression(job.if, context('merge_group', { results })), false, `results ${results}`);
  // Without a status function GitHub adds success(), which a skipped job further up
  // (pr-test-input in a merge group) makes false: the publish was skipped in run 42843943744.
  assert.match(String(job.if), /!cancelled\(\)/, 'the condition carries its own status function');
  assert.deepEqual(job.permissions, { contents: 'write' });
  for (const [id, other] of Object.entries(jobs)) {
    if (id !== 'squeal-publish') assert.notEqual(other.permissions?.contents, 'write', `${id} writes contents`);
  }
  const checkout = job.steps.find((s) => s.uses?.startsWith('actions/checkout@'));
  assert.equal(checkout.with.ref, '${{ github.event.merge_group.head_sha }}');
  assert.equal(checkout.with['fetch-depth'], 0, 'pruning places refs on the first-parent line');
  assert.equal(checkout.with['persist-credentials'], false, 'no token on disk');
  assert.deepEqual(job.steps.map((s) => s.uses?.split('@')[0]).filter(Boolean),
    ['actions/checkout', 'actions/setup-node', 'hearsay-tools/squeal/ci', 'actions/download-artifact']);
  assert.equal(job.steps.find((s) => s.uses?.startsWith('actions/setup-node@')).with['package-manager-cache'], false);
  for (const s of job.steps.filter((s) => s.run)) {
    assert.doesNotMatch(s.run, /\b(npm|pnpm|npx|yarn|corepack)\b|build|\.\/|node_modules/, `${s.name} runs repository code`);
    assert.doesNotMatch(s.run, /^\s*node\b/m, `${s.name} runs a script outside Squeal's action`);
  }
  // The token reaches only the publish step, as git configuration in its environment.
  const tokened = Object.entries(jobs).flatMap(([id, other]) => (other.steps ?? []).map((s) => ({ id, s })))
    .filter(({ id, s }) => SQUEAL_JOBS.includes(id) && /github\.token|secrets\./.test(JSON.stringify(s)));
  assert.deepEqual(tokened.map(({ s }) => s.name), ['Publish Squeal results']);
  assert.deepEqual(Object.keys(step(job, 'Publish Squeal results').env), ['GH_TOKEN']);
});

test('the publish step hands git the token as an extra header and masks it', () => {
  const publish = step(ci().jobs['squeal-publish'], 'Publish Squeal results');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-squeal-publish-'));
  try {
    fs.writeFileSync(path.join(temp, 'squeal'), '#!/bin/sh\necho "count=$GIT_CONFIG_COUNT key=$GIT_CONFIG_KEY_0 value=$GIT_CONFIG_VALUE_0 args=$*"\nexit 4\n', { mode: 0o755 });
    const result = spawnSync('bash', ['-e', '-c', publish.run], {
      encoding: 'utf8', env: { PATH: `${temp}:/usr/bin:/bin`, RUNNER_TEMP: '/runner/temp', GH_TOKEN: 'tok' },
    });
    const basic = Buffer.from('x-access-token:tok').toString('base64');
    assert.equal(result.status, 4, 'the publish exit code is the step\'s');
    assert.equal(result.stdout, `::add-mask::${basic}\ncount=1 key=http.https://github.com/.extraheader value=AUTHORIZATION: basic ${basic} `
      + 'args=ci publish /runner/temp/squeal-results/squeal-results.json.gz --keep 100\n');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('verify waits for the Squeal jobs but never reads their results', () => {
  const { jobs } = ci();
  const { REQUIRED_QUEUE_JOBS } = require('./queue-ci-proof.cjs');
  // The ref for a merge group's commit exists before main moves to it, so a worktree that
  // fast-forwards or rebases onto the new main finds results to import.
  for (const id of ['squeal-export', 'squeal-publish']) assert.ok(jobs.verify.needs.includes(id), `verify waits for ${id}`);
  const verify = JSON.stringify(jobs.verify.steps);
  for (const id of SQUEAL_JOBS) {
    for (const [other, job] of Object.entries(jobs)) {
      if (![...SQUEAL_JOBS, 'verify'].includes(other)) assert.equal([job.needs ?? []].flat().includes(id), false, `${other} needs ${id}`);
    }
    assert.ok(!verify.includes(id) && !verify.includes(`needs['${id}']`), `verify reads ${id}`);
    assert.equal(REQUIRED_QUEUE_JOBS.includes(jobs[id].name), false);
  }
});

test('squeal-export keys the shard parts in a fresh checkout; squeal-publish pushes that export', () => {
  const { jobs } = ci();
  const others = new Set(Object.entries(jobs).filter(([id]) => !SQUEAL_JOBS.includes(id))
    .flatMap(([, other]) => (other.steps ?? []).map((s) => s.uses?.split(' ')[0])).filter(Boolean));
  for (const id of SQUEAL_JOBS) {
    for (const s of jobs[id].steps.filter((s) => s.uses)) {
      assert.match(s.uses, /@[0-9a-f]{40}( |$)|^\.\/\.github\/actions\/node-dist$/, s.uses);
      assert.ok(others.has(s.uses.split(' ')[0]), `${s.uses} matches the pin the rest of ci.yml uses`);
    }
    for (const s of jobs[id].steps) if (s.run) assert.equal(/\$\{\{/.test(s.run), false, `${id} ${s.name}: no expression in a script`);
  }
  const job = jobs['squeal-export'];
  assert.equal(job.steps.find((s) => s.uses?.startsWith('pnpm/action-setup@')).with.version, '12.11.2');
  const runs = job.steps.map((s) => s.run).filter(Boolean);
  assert.ok(runs.includes('pnpm install --frozen-lockfile'));
  const builds = (j) => j.steps.some((s) => s.run === 'npm run build:server');
  assert.equal(builds(job), builds(jobs.vitest), 'the export checkout holds what the shards read');
  assert.equal(runs.some((run) => /npm (test|run test)|vitest run/.test(run)), false, 'the job runs no test command');
  const pattern = step(job, 'Download Squeal parts').with.pattern;
  assert.equal(pattern, 'squeal-parts-shard-*');
  // `squeal ci export` refuses parts that lack a shard of their count, so the download takes every matrix shard's parts.
  const uploaded = step(jobs.vitest, 'Upload Squeal parts').with.name;
  const parts = jobs.vitest.strategy.matrix.shard.map((n) => uploaded.replace('${{ matrix.shard }}', String(n)));
  assert.equal(parts.length, 8);
  assert.deepEqual(parts.filter((name) => !name.startsWith(pattern.slice(0, -1))), []);
  assert.equal(step(job, 'Download Squeal node:test parts').with.name, step(jobs['squeal-node-test'], 'Upload Squeal parts').with.name);
  assert.equal(step(job, 'Download Squeal node:test parts')['continue-on-error'], true, 'missing node:test parts never fail the export');
  const browserDownload = step(job, 'Download Squeal browser parts');
  assert.equal(browserDownload['continue-on-error'], true, 'missing browser parts never fail the export');
  assert.equal(browserDownload.with.pattern, 'squeal-parts-browser-shard-*');
  assert.equal(browserDownload.with.path, '${{ runner.temp }}/squeal-parts-browser');
  for (const [browser, runsDownload] of [['success', true], ['failure', false], ['skipped', false], ['cancelled', false]]) {
    assert.equal(expression(browserDownload.if, context('merge_group', { browser })), runsDownload, `browser download when ${browser}`);
  }
  const browserUploaded = step(jobs['cockpit-browser'], 'Upload Squeal parts').with.name;
  const browserParts = jobs['cockpit-browser'].strategy.matrix.shard.map((n) => browserUploaded.replace('${{ matrix.shard }}', String(n)));
  assert.equal(browserParts.length, 8);
  assert.deepEqual(browserParts.filter((name) => !name.startsWith(browserDownload.with.pattern.slice(0, -1))), []);
  const upload = step(job, 'Upload Squeal results');
  assert.equal(upload.with.path, '${{ runner.temp }}/squeal-results.json.gz');
  assert.equal(upload.with['retention-days'], 3);
  const download = step(jobs['squeal-publish'], 'Download Squeal results');
  assert.equal(download.with.name, upload.with.name);
  assert.equal(download.with.path, '${{ runner.temp }}/squeal-results');
});

test('every job that runs squeal sets up Squeal\'s pinned action once, after its Node and before the first squeal call', () => {
  const { jobs } = ci();
  const text = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
  // One pin for the whole workflow: an exact commit with its release tag in the comment.
  const pins = text.match(/^\s*uses: hearsay-tools\/squeal\/ci@.*$/gm);
  assert.ok(pins.length > 0);
  for (const pin of pins) assert.equal(pin.trim(), SQUEAL_PIN);
  const users = Object.entries(jobs).filter(([, job]) => (job.steps ?? []).some((s) => /(^|\s)squeal (ci|code)\b/m.test(s.run ?? '')))
    .map(([id]) => id);
  assert.deepEqual(users.sort(), ['cockpit-browser', 'squeal-export', 'squeal-node-test', 'squeal-publish', 'vitest']);
  for (const [id, job] of Object.entries(jobs)) {
    const { steps = [] } = job;
    const action = steps.filter((s) => s.uses?.startsWith('hearsay-tools/squeal/'));
    if (!users.includes(id)) {
      assert.deepEqual(action, [], `${id} runs no squeal`);
      continue;
    }
    assert.equal(action.length, 1, `${id}: one Squeal action step`);
    assert.equal(action[0].name, 'Set up Squeal', id);
    assert.equal(action[0].uses, SQUEAL_ACTION, id);
    assert.equal(action[0].with, undefined, `${id}: the action takes no inputs`);
    const at = steps.indexOf(action[0]);
    // The action runs Squeal with the Node on the PATH, so it comes after setup-node.
    assert.ok(steps.findIndex((s) => s.uses?.startsWith('actions/setup-node@')) < at, `${id}: after setup-node`);
    const first = steps.findIndex((s) => /(^|\s)squeal (ci|code)\b/m.test(s.run ?? ''));
    assert.ok(first > at, `${id}: before the first squeal call`);
  }
});

test('squeal.config.json reads the shared results ref squeal-publish writes', () => {
  const config = JSON.parse(fs.readFileSync(path.join(repoRoot, 'squeal.config.json'), 'utf8'));
  assert.deepEqual(config.shared, { ref: 'refs/squeal' });
});

// `squeal ci export` warns and exits 0 when it writes nothing (hearsay-tools/squeal spec 018 D20).
// The job then passes without a file: no upload, no publish, no failed run that costs main a full
// CI run (hearsay-tools/squawk#3701).
test('an export that writes no file skips the upload and the publish without failing the job', () => {
  const job = ci().jobs['squeal-export'];
  const names = job.steps.map((s) => s.name);
  const check = step(job, 'results');
  assert.equal(check.name, 'Check for the Squeal results file');
  assert.equal(names.indexOf(check.name), names.indexOf('Export Squeal results') + 1);
  assert.equal(names.indexOf('Upload Squeal results'), names.indexOf(check.name) + 1);
  assert.equal(job.outputs.results, '${{ steps.results.outputs.exists }}');
  const upload = step(job, 'Upload Squeal results');
  assert.equal(upload.with['if-no-files-found'], 'error', 'a file the check saw must upload');
  for (const [exists, runs] of [['true', true], ['false', false]]) {
    assert.equal(expression(upload.if, context('merge_group', { steps: { results: { outputs: { exists } } } })), runs, exists);
  }
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-squeal-results-'));
  try {
    const output = path.join(temp, 'output');
    const read = () => {
      fs.writeFileSync(output, '');
      const result = spawnSync('bash', ['-e', '-c', check.run], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', RUNNER_TEMP: temp, GITHUB_OUTPUT: output } });
      assert.equal(result.status, 0, result.stderr);
      return fs.readFileSync(output, 'utf8');
    };
    assert.equal(read(), 'exists=false\n', 'no file');
    fs.writeFileSync(path.join(temp, 'squeal-results.json.gz'), '');
    assert.equal(read(), 'exists=false\n', 'an empty file');
    fs.writeFileSync(path.join(temp, 'squeal-results.json.gz'), 'x');
    assert.equal(read(), 'exists=true\n', 'a written file');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

// node:test results for Squeal (hearsay-tools/squeal spec 018 D23, D26, D29): a merge-group-only job
// runs both unit suites on .node-version with Squeal's reporter added. The export leaves out a suite
// whose flags differ from its squeal.config.json nodeTest entry, so the recorded commands must keep
// the package scripts' flags.
test('squeal-node-test records both unit suites with the nodeTest entries\' flags, in merge groups only', () => {
  const { jobs } = ci();
  const job = jobs['squeal-node-test'];
  for (const event of EVENTS) assert.equal(expression(job.if, context(event)), event === 'merge_group', event);
  assert.deepEqual(job.permissions, { contents: 'read' });
  const config = JSON.parse(fs.readFileSync(path.join(repoRoot, 'squeal.config.json'), 'utf8'));
  const scripts = (dir) => JSON.parse(fs.readFileSync(path.join(repoRoot, dir, 'package.json'), 'utf8')).scripts;
  const REPORTERS = ' --test-reporter=spec --test-reporter-destination=stdout'
    + ' --test-reporter="$SQUEAL_NODE_TEST_REPORTER" --test-reporter-destination=stderr ';
  const suites = [
    ['Record package unit tests', 'packages/cezar', scripts('packages/cezar')['test:unit'], 'package'],
    ['Record repository script tests', '.', scripts('.')['test:unit:scripts'], 'scripts'],
  ];
  for (const [name, cwd, command, suite] of suites) {
    const s = step(job, name);
    assert.equal(s['working-directory'] ?? '.', cwd, name);
    const prefix = `squeal ci record --out "$RUNNER_TEMP/squeal-parts-node-test/${suite}" -- `;
    assert.ok(s.run.startsWith(prefix), name);
    // The package script's command with the reporter pair after --test.
    assert.equal(s.run.slice(prefix.length), command.replace(' --test ', ` --test${REPORTERS}`), name);
    const entry = config.nodeTest.find((e) => (e.cwd ?? '.') === cwd);
    const flags = command.split(' --test ')[0].split(' ').slice(1);
    assert.deepEqual(flags, entry.argv, `${name}: the nodeTest entry's argv`);
    assert.doesNotMatch(s.run, /NODE_OPTIONS/, `${name}: the export job sets no NODE_OPTIONS either`);
  }
  assert.equal(step(job, 'Record repository script tests').if, '!cancelled()', 'both suites record when one fails');
  const upload = step(job, 'Upload Squeal parts');
  assert.match(String(upload.if), /^!cancelled\(\)$/);
  assert.equal(upload['continue-on-error'], true);
  assert.equal(upload.with.path, '${{ runner.temp }}/squeal-parts-node-test/');
  assert.equal(upload.with['retention-days'], 3);
});

test('the export adds node:test and complete browser shard parts, and falls back to Vitest + node:test when browser parts are incomplete or refused', () => {
  const run = step(ci().jobs['squeal-export'], 'Export Squeal results').run;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-squeal-export-'));
  try {
    const bin = path.join(temp, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'squeal'), [
      '#!/bin/sh',
      'echo "squeal $*"',
      'if [ "${REFUSE_BROWSER:-}" = 1 ] && echo "$*" | grep -q squeal-parts-browser; then exit 0; fi',
      'printf x > "$RUNNER_TEMP/squeal-results.json.gz"',
    ].join('\n') + '\n', { mode: 0o755 });
    for (const n of [1, 2]) fs.mkdirSync(path.join(temp, 'squeal-parts', `squeal-parts-shard-${n}`), { recursive: true });
    const exported = (extraEnv = {}) => {
      fs.rmSync(path.join(temp, 'squeal-results.json.gz'), { force: true });
      const result = spawnSync('bash', ['-e', '-c', run], {
        encoding: 'utf8',
        env: { PATH: `${bin}:/usr/bin:/bin`, RUNNER_TEMP: temp, ...extraEnv },
      });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout;
    };
    const shards = `${temp}/squeal-parts/squeal-parts-shard-1 ${temp}/squeal-parts/squeal-parts-shard-2`;
    const out = `--out ${temp}/squeal-results.json.gz\n`;
    assert.equal(exported(), `squeal ci export --parts ${shards} ${out}`);
    fs.mkdirSync(path.join(temp, 'squeal-parts-node-test', 'scripts'), { recursive: true });
    assert.equal(exported(), `squeal ci export --parts ${shards} ${temp}/squeal-parts-node-test/scripts ${out}`);
    fs.mkdirSync(path.join(temp, 'squeal-parts-node-test', 'package'));
    const unitAndNode = `${shards} ${temp}/squeal-parts-node-test/package ${temp}/squeal-parts-node-test/scripts`;
    assert.equal(exported(), `squeal ci export --parts ${unitAndNode} ${out}`);
    // Fewer than 8 non-empty browser shard directories are ignored so Vitest + node:test still export.
    for (let n = 1; n <= 7; n++) {
      const dir = path.join(temp, 'squeal-parts-browser', `squeal-parts-browser-shard-${n}`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'part.json'), '{}');
    }
    fs.mkdirSync(path.join(temp, 'squeal-parts-browser', 'squeal-parts-browser-shard-8'), { recursive: true });
    assert.equal(exported(), `squeal ci export --parts ${unitAndNode} ${out}`, 'empty 8th browser shard dir is treated as incomplete');
    fs.writeFileSync(path.join(temp, 'squeal-parts-browser', 'squeal-parts-browser-shard-8', 'part.json'), '{}');
    const browserShards = Array.from({ length: 8 }, (_, i) => `${temp}/squeal-parts-browser/squeal-parts-browser-shard-${i + 1}`).join(' ');
    assert.equal(exported(), `squeal ci export --parts ${unitAndNode} ${browserShards} ${out}`, 'all 8 non-empty browser shard dirs join the export');
    const fallback = exported({ REFUSE_BROWSER: '1' });
    assert.equal(
      fallback,
      `squeal ci export --parts ${unitAndNode} ${browserShards} ${out}`
        + '::warning::Squeal export with browser parts wrote no file; retrying without browser parts.\n'
        + `squeal ci export --parts ${unitAndNode} ${out}`,
      'if exporting with browser parts writes no file, the step retries without browser parts',
    );
    assert.equal(fs.readFileSync(path.join(temp, 'squeal-results.json.gz'), 'utf8'), 'x');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
