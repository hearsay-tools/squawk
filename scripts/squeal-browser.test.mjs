import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { createVitest, parseCLI } from 'vitest/node';
import { DatabaseSync } from 'node:sqlite';

const root = fileURLToPath(new URL('../', import.meta.url));

async function list(options = {}) {
  const vitest = await createVitest('test', { root, watch: false, reporters: [], ...options });
  try {
    await vitest.standalone();
    return Object.assign(await vitest.globTestSpecifications(), { reporters: vitest.reporters });
  } finally {
    await vitest.close();
  }
}

test('Squeal can discover browser E2E through the root Vitest configuration', async () => {
  const specs = await list();
  assert.ok(specs.some(spec => spec.project.name === 'e2e' && spec.moduleId.endsWith('/smoke.e2e.ts')),
    'the root configuration must expose browser E2E to Squeal');
  // hearsay-tools/squawk#3538: the per-run environment survives a caller's own `reporters`.
  assert.ok(specs.reporters.some(reporter => reporter.constructor.name === 'RunEnvironment'));
});

test('npm test selects only the four unit projects without starting a browser', async () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const { options } = parseCLI(manifest.scripts.test);
  const specs = await list(options);
  assert.deepEqual([...new Set(specs.map(spec => spec.project.name))].sort(),
    ['api-client', 'contract', 'server', 'web']);
  assert.ok(specs.every(spec => !spec.moduleId.endsWith('.e2e.ts')));
});

function bootstrap(t, { installed = true, bootExit = 0, tmp, registryFailure, borrowed = false, script } = {}) {
  const source = new URL('../packages/web/e2e/environment.ts', import.meta.url);
  assert.ok(existsSync(source), 'browser E2E needs a run environment');
  const fixture = mkdtempSync(join(tmpdir(), 'cez-squeal-browser-'));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  mkdirSync(join(fixture, 'packages/web/e2e'), { recursive: true });
  mkdirSync(join(fixture, '.ai/scripts'), { recursive: true });
  // This fixture exercises bootstrap without workspace packages. Keep its local
  // install boundary real so the shared resolution guard runs here too.
  mkdirSync(join(fixture, 'node_modules'));
  mkdirSync(join(fixture, 'scripts'));
  writeFileSync(join(fixture, 'package.json'), JSON.stringify({ type: 'module', workspaces: [] }));
  copyFileSync(new URL('./check-workspace-resolution.mjs', import.meta.url),
    join(fixture, 'scripts/check-workspace-resolution.mjs'));
  const modulePath = join(fixture, 'packages/web/e2e/environment.ts');
  copyFileSync(source, modulePath);
  copyFileSync(new URL('../.ai/scripts/test-env-lease.mjs', import.meta.url),
    join(fixture, '.ai/scripts/test-env-lease.mjs'));
  // The lease imports the process-group helper from source; the marker makes it an ES module.
  mkdirSync(join(fixture, 'packages/cezar/src/core'), { recursive: true });
  copyFileSync(new URL('../packages/cezar/src/detached-process.ts', import.meta.url),
    join(fixture, 'packages/cezar/src/detached-process.ts'));
  copyFileSync(new URL('../packages/cezar/src/core/process-stat.ts', import.meta.url),
    join(fixture, 'packages/cezar/src/core/process-stat.ts'));
  writeFileSync(join(fixture, 'packages/cezar/src/package.json'), '{"type":"module"}\n');
  // Replace only the server-dependent registry pin. Check committed ownership at
  // its restoration boundary, where releasing the lease too early would race.
  writeFileSync(join(fixture, 'packages/web/e2e/workspace-registry.ts'), `
    import { DatabaseSync } from 'node:sqlite';
    import { writeFileSync } from 'node:fs';
    export async function setup() {
      ${registryFailure === 'setup' ? "throw new Error('registry setup failed');" : ''}
      return () => {
        const db = new DatabaseSync('.ai/qa/test-env-lease.sqlite', { readOnly: true });
        const n = db.prepare('SELECT count(*) AS n FROM holders').get().n;
        db.close();
        if (!n) throw new Error('registry restored after lease release');
        writeFileSync('registry-restored', 'restored');
        ${registryFailure === 'restore' ? "throw new Error('registry restore failed');" : ''}
      };
    }
  `);
  copyFileSync(new URL('../.ai/scripts/resolve-browser-launch.mjs', import.meta.url),
    join(fixture, '.ai/scripts/resolve-browser-launch.mjs'));
  const runtimeTmp = join(fixture, 'browser-tmp');
  mkdirSync(runtimeTmp);
  const descriptor = JSON.stringify({ browser: {
    installed, notes: 'Chrome fixture unavailable', runtimeEnv: { TMPDIR: runtimeTmp },
  } }).replace(/'/g, "'\\''");
  writeFileSync(join(fixture, '.ai/scripts/test-env-up.sh'), `#!/bin/sh
printf 'booted\\n' >> booted
mkdir -p .ai/qa
printf '%s\\n' '${descriptor}' > .ai/qa/test-env.json
exit ${bootExit}
`);
  const callerTmp = tmp ?? '/tmp';
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script?.(modulePath) ?? `
    import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
    import { acquireTestEnvLease } from ${JSON.stringify(pathToFileURL(join(fixture, '.ai/scripts/test-env-lease.mjs')).href)};
    import { setup } from ${JSON.stringify(pathToFileURL(modulePath).href)};
    let outer;
    if (${borrowed}) {
      outer = await acquireTestEnvLease(process.cwd());
      process.env.TEST_ENV_LEASE_TOKEN = outer.token;
      process.env.TEST_ENV_LEASE_BOOTSTRAPPED = '1';
      writeFileSync('.ai/qa/test-env.json', JSON.stringify({ browser: { installed: true } }));
    }
    const teardown = await setup();
    const tmp = process.env.TMPDIR;
    const existed = existsSync(tmp);
    teardown();
    outer?.release();
    console.log(JSON.stringify({ tmp, existed, removed: !existsSync(tmp), restored: process.env.TMPDIR }));
  `], {
    cwd: fixture,
    encoding: 'utf8',
    timeout: 10_000,
    env: { ...process.env, TEST_ENV_LEASE_TOKEN: '', TEST_ENV_LEASE_ENTRY: '', TEST_ENV_LEASE_BOOTSTRAPPED: '', TEST_ENV_LEASE_JOB: '', TEST_ENV_LEASE_BROKER: '', TMPDIR: callerTmp, TMP: callerTmp, TEMP: callerTmp },
  });
  return { ...result, fixture, runtimeTmp, callerTmp };
}

function report(result) {
  return JSON.parse(result.stdout.trim().split('\n').at(-1));
}

// hearsay-tools/cezarion#1090: the descriptor's runtimeEnv is the answer for whoever booted
// the shared env; run setup decides the socket-safe TMPDIR from its own caller's env.
test('browser run setup runs the project bootstrap and keeps its caller’s short TMPDIR', t => {
  const result = bootstrap(t);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(result.fixture, 'booted'), 'utf8'), 'booted\n');
  assert.equal(report(result).tmp, result.callerTmp);
  assert.notEqual(report(result).tmp, result.runtimeTmp);
  assert.equal(readFileSync(join(result.fixture, 'registry-restored'), 'utf8'), 'restored');
});

test('browser run setup gives an over-budget caller a short TMPDIR and removes it at teardown', t => {
  const result = bootstrap(t, { tmp: `/${'x'.repeat(120)}` });
  assert.equal(result.status, 0, result.stderr);
  const { tmp, existed, removed, restored } = report(result);
  assert.ok(tmp.startsWith('/tmp/cez-e2e-'), tmp);
  assert.equal(existed, true);
  assert.equal(removed, true);
  assert.equal(restored, result.callerTmp);
});

test('a browser unavailable after bootstrap cannot become a passing Squeal result', t => {
  const result = bootstrap(t, { installed: false });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Chrome fixture unavailable/);
});

test('failed browser environment bootstrap prevents test execution', t => {
  const result = bootstrap(t, { bootExit: 9 });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /bootstrap failed/);
});

test('wrapper-owned run setup joins the live lease without bootstrapping a second time', t => {
  const result = bootstrap(t, { borrowed: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(result.fixture, 'booted')), false);
  assert.equal(existsSync(join(result.fixture, 'registry-restored')), true);
});

for (const [failure, reason] of [
  [{ installed: false }, /Chrome fixture unavailable/], [{ bootExit: 9 }, /bootstrap failed/],
  [{ registryFailure: 'setup' }, /registry setup failed/], [{ registryFailure: 'restore' }, /registry restore failed/],
]) {
  test(`run setup releases its committed lease after failure ${JSON.stringify(failure)}`, t => {
    const result = bootstrap(t, failure);
    assert.notEqual(result.status, 0, result.stderr);
    assert.match(result.stderr, reason);
    const db = new DatabaseSync(join(result.fixture, '.ai/qa/test-env-lease.sqlite'), { readOnly: true });
    try { assert.equal(db.prepare('SELECT count(*) AS n FROM holders').get().n, 0); }
    finally { db.close(); }
  });
}

// hearsay-tools/squawk#3538: a long-lived host such as the Squeal daemon runs many test runs.
// Each run that needs the browser holds the lease only until it ends; the host lives on.
test('each browser test run holds the lease only while it runs, in a host that keeps running', t => {
  const result = bootstrap(t, { script: modulePath => `
    import { existsSync, readFileSync, rmSync } from 'node:fs';
    import { DatabaseSync } from 'node:sqlite';
    import RunEnvironment from ${JSON.stringify(pathToFileURL(modulePath).href)};
    const holders = () => {
      if (!existsSync('.ai/qa/test-env-lease.sqlite')) return 0;
      const db = new DatabaseSync('.ai/qa/test-env-lease.sqlite', { readOnly: true });
      try { return db.prepare('SELECT count(*) AS n FROM holders').get().n; } finally { db.close(); }
    };
    // A run's specifications at its start, and its test modules at its end.
    const e2e = [{ project: { name: 'e2e' } }];
    const unit = [{ project: { name: 'web' } }];
    const host = new RunEnvironment({ project: 'e2e' });
    const seen = [];
    await host.onTestRunStart(unit); seen.push(['unit run', holders()]); await host.onTestRunEnd(unit);
    await host.onTestRunStart(e2e); seen.push(['browser run', holders()]);
    await host.onTestRunEnd(e2e); seen.push(['browser run ended', holders()]);
    rmSync('registry-restored');
    // Overlapping runs share one environment; Vitest's real orderings are pinned below.
    await host.onTestRunStart(e2e); await host.onTestRunStart(unit); await host.onTestRunStart(e2e);
    seen.push(['overlapping runs', holders()]);
    await host.onTestRunEnd(e2e); seen.push(['first ended', holders()]);
    await host.onTestRunEnd(unit); seen.push(['unit ended', holders()]);
    const restoredEarly = existsSync('registry-restored');
    await host.onTestRunEnd(e2e); seen.push(['last ended', holders()]);
    let prepared = 0, released = 0;
    const flaky = new RunEnvironment({ project: 'e2e', prepare: async () => {
      if (++prepared === 1) throw new Error('boot failed');
      return () => { released++; };
    } });
    const failure = await flaky.onTestRunStart(e2e).then(() => 'resolved', error => error.message);
    await flaky.onTestRunStart(e2e); await flaky.onTestRunEnd(e2e);
    console.log(JSON.stringify({ seen, boots: readFileSync('booted', 'utf8').split('\\n').filter(Boolean).length,
      restoredEarly, restored: existsSync('registry-restored'), failure, prepared, released }));
  ` });
  assert.equal(result.status, 0, result.stderr);
  const { seen, boots, restoredEarly, restored, failure, prepared, released } = report(result);
  assert.deepEqual(seen, [
    ['unit run', 0], ['browser run', 1], ['browser run ended', 0],
    ['overlapping runs', 1], ['first ended', 1], ['unit ended', 1], ['last ended', 0],
  ]);
  assert.equal(boots, 2);
  assert.equal(restoredEarly, false);
  assert.equal(restored, true);
  assert.deepEqual({ failure, prepared, released }, { failure: 'boot failed', prepared: 2, released: 1 });
});

// hearsay-tools/squawk#3538: Vitest's own run ordering, with a pool whose runs end on command.
// The installed Vitest.runFiles decides when each run starts and ends; only the pool is a stub.
// Each stub run registers its modules as Vitest's pool does, unless it crashes before that.
async function runHost(t, { prepare } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cez-run-env-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'b.e2e.ts'), '');
  writeFileSync(join(dir, 'u.test.ts'), '');
  writeFileSync(join(dir, 'vitest.config.mjs'), `export default { test: { projects: [
    { test: { name: 'e2e', include: ['b.e2e.ts'] } }, { test: { name: 'web', include: ['u.test.ts'] } },
  ] } }`);
  const env = { prepared: 0, released: 0 };
  const environment = fileURLToPath(new URL('../packages/web/e2e/environment.ts', import.meta.url));
  const vitest = await createVitest('test', { root: dir, watch: false, reporters: [[environment, {
    project: 'e2e',
    prepare: prepare ?? (async () => { env.prepared++; return () => { env.released++; }; }),
  }]] });
  // Vitest marks its host process failed after a failed run, as the crash case is meant to be.
  const exitCode = process.exitCode;
  t.after(async () => { await vitest.close(); process.exitCode = exitCode; });
  await vitest.standalone();
  const specs = await vitest.globTestSpecifications();
  const spec = name => specs.find(s => s.project.name === name);
  /** Started runs per project, in start order, until the pool takes them. */
  const pooled = { e2e: [], web: [] };
  const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
  vitest.pool = {
    name: 'stub',
    async runTests(specifications) {
      // Vitest reaches the pool in its own order: take the oldest started run of this project.
      const run = pooled[specifications[0].project.name].shift();
      run.entered.resolve();
      if (!run.crash) for (const s of specifications) vitest.state.clearFiles(s.project, [s.moduleId]);
      await run.promise;
      if (run.crash) throw new Error('pool crashed before collection');
    },
    async collectTests() {},
    async close() {},
  };
  /** Start a run; its pool entry ends when `finish()` is called. */
  const start = (name, { crash = false } = {}) => {
    const run = { ...deferred(), entered: deferred(), crash };
    pooled[name].push(run);
    const done = vitest.runTestSpecifications([spec(name)]);
    return { done, entered: run.entered.promise, finish: () => run.resolve() };
  };
  return { env, start };
}

// bound: one macrotask turn lets every queued microtask of runFiles settle; nothing waits on time.
const settle = () => new Promise(resolve => setImmediate(resolve));

test('several runs released by one earlier run: a unit run that ends first keeps the browser environment', async t => {
  const { env, start } = await runHost(t);
  const u0 = start('web'); await u0.entered;
  // The browser run's start resolves first, then the unit run's; both then wait for u0's run.
  const browser = start('e2e'); await settle();
  const u1 = start('web'); await settle();
  u0.finish(); await u0.done;
  await Promise.all([browser.entered, u1.entered]);
  u1.finish(); await u1.done;
  assert.deepEqual(env, { prepared: 1, released: 0 }, 'the unit end released the browser environment');
  browser.finish(); await browser.done;
  assert.deepEqual(env, { prepared: 1, released: 1 });
});

test('two browser runs that end in reverse order share one environment until the last ends', async t => {
  const { env, start } = await runHost(t);
  const u0 = start('web'); await u0.entered;
  const first = start('e2e'); await settle();
  const second = start('e2e'); await settle();
  u0.finish(); await u0.done;
  await Promise.all([first.entered, second.entered]);
  second.finish(); await second.done;
  assert.deepEqual(env, { prepared: 1, released: 0 });
  first.finish(); await first.done;
  assert.deepEqual(env, { prepared: 1, released: 1 });
});

test('a browser run that crashes before collection still releases, after the unit run beside it', async t => {
  const { env, start } = await runHost(t);
  const u0 = start('web'); await u0.entered;
  const browser = start('e2e', { crash: true }); await settle();
  const u1 = start('web'); await settle();
  u0.finish(); await u0.done;
  await Promise.all([browser.entered, u1.entered]);
  browser.finish(); await browser.done;
  assert.deepEqual(env, { prepared: 1, released: 0 }, 'a run with no modules is not known to be the browser run while a unit run is open');
  u1.finish(); await u1.done;
  assert.deepEqual(env, { prepared: 1, released: 1 }, 'no holder may outlive the last run');
  const alone = start('e2e', { crash: true }); await alone.entered;
  alone.finish(); await alone.done;
  assert.deepEqual(env, { prepared: 2, released: 2 });
});

test('a unit run that starts and ends while a browser run boots keeps the browser environment', async t => {
  let boot;
  const env = { released: 0 };
  const { start } = await runHost(t, { prepare: () => new Promise(resolve => { boot = resolve; }) });
  const browser = start('e2e');
  const unit = start('web'); await unit.entered;
  unit.finish(); await unit.done;
  boot(() => { env.released++; });
  await browser.entered;
  assert.equal(env.released, 0);
  browser.finish(); await browser.done;
  assert.equal(env.released, 1);
});
