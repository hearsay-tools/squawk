/** Integration-only: npm run build:server && node packages/cezar/scripts/measure-transcript-facts-health.mjs
 * Boots the actual loopback server; deliberately never imported by the fast tests.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { PerformanceObserver } from 'node:perf_hooks';
import { timingSnapshot, timingDelta, blockingBudget, prepareOpenTiming, hookCalls, callsWithin, startThreadWatch, summarizeWaits, attachWaitsOverBudget } from './transcript-facts-timing.mjs';
import { seedColdHistories, verifyFacts } from './transcript-facts-fixture.mjs';

const BUDGET_MS = 50;
const root = mkdtempSync(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'cez-facts-health-'));
// The experiment has no external peers, credentials, background updater, or real home.
for (const key of Object.keys(process.env)) if (/^(CEZ|HSQ)_/.test(key)) delete process.env[key];
process.env.HSQ_HOME = process.env.CEZ_HOME = join(root, 'home');
process.env.HSQ_DRY_RUN = process.env.CEZ_DRY_RUN = '1';
const runtime = { url: new URL('../dist/', import.meta.url), ext: 'js' };
const timedOpen = await prepareOpenTiming(runtime);
let openTiming;
let dataDir;
let store;
let bootStore;
let server;
let unhookCalls;
let gcObserver;
let threadWatch;
const watchdog = setTimeout(() => { console.error('health measurement exceeded 30s'); process.exitCode = 1; server?.closeAllConnections(); server?.close(); store?.close(); bootStore?.close(); }, 30_000);
try {
  const { RunStore } = await import(new URL('runs/store.js', runtime.url));
  // Seed where the built revision's cockpit reads each project, so a cockpit start moves nothing.
  const { projectPaths } = await import(new URL('project-paths.js', runtime.url));
  dataDir = projectPaths(join(root, 'cold-project')).write;
  const { startServer } = await import(new URL('server/start-server.js', runtime.url));
  const { installPluginResolveHook } = await import(new URL('plugin/resolve-hook.js', runtime.url));
  installPluginResolveHook();
  const { loadBundledRunners } = await import(new URL('plugin/loader.js', runtime.url));
  const { sealRunners } = await import(new URL('core/runner-registry.js', runtime.url));
  // This measurement is a process entry like index.ts: the server reads every registered runner,
  // and a reclaim or a deletion asks the removal slots.
  await loadBundledRunners();
  sealRunners();
  const { registerBuiltInRunSlots, sealBuiltInRunSlots } = await import(new URL('built-in-run-slots.js', runtime.url));
  registerBuiltInRunSlots();
  sealBuiltInRunSlots();
  const { registerBuiltInLaunchParts, sealBuiltInLaunchParts } = await import(new URL('built-in-launch-parts.js', runtime.url));
  registerBuiltInLaunchParts();
  sealBuiltInLaunchParts();
  const { registerBuiltInStepKinds, sealBuiltInStepKinds } = await import(new URL('workflows/step-kind-registry.js', runtime.url));
  registerBuiltInStepKinds();
  sealBuiltInStepKinds();
  const { registerBuiltInWaitKinds, sealBuiltInWaitKinds } = await import(new URL('built-in-wait-kinds.js', runtime.url));
  registerBuiltInWaitKinds();
  sealBuiltInWaitKinds();
  const { registerBuiltInTools, sealBuiltInTools } = await import(new URL('built-in-tools.js', runtime.url));
  registerBuiltInTools();
  sealBuiltInTools();
  const { RunManager } = await import(new URL('workflows/run.js', runtime.url));
  const { acquireCiResources } = await import(new URL('ci-wait/resources.js', runtime.url));
  const { resolveHome } = await import(new URL('home/resolve.js', runtime.url));
  const home = resolveHome({ purpose: 'cli' });
  const { Home } = await import(new URL('home/home.js', runtime.url));
  Home.sandbox(home.rootOverride ?? home.root, { layout: home.layout });
  // Keep git discovery away from the user's parent repository, even if TMPDIR
  // was set inside a Squawk worktree. This repo contains only the experiment.
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: root, stdio: 'ignore' });
  const fixtures = await seedColdHistories(dataDir, runtime);
  global.gc?.();
  // Project-open scenario: establish the real HTTP/client path before opening a
  // second cold store on this same event loop. No transcript sidecar is primed.
  bootStore = RunStore.open(projectPaths(root).write);
  await bootStore.transcriptFacts.factsWarmIdle();
  server = startServer({ home, repoRoot: root, store: bootStore, manager: {}, createManager: (store, root, options) => new RunManager(store, root, { ...options, acquireCiResources }), version: 'task4-measurement', bindHost: '127.0.0.1' }, 0);
  if (!server.listening) await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const endpoint = `http://127.0.0.1:${address.port}/api/v1/health`;
  const primingStart = performance.now();
  const prime = await fetch(endpoint, { signal: AbortSignal.timeout(2_000) });
  assert.equal(prime.status, 200);
  assert.equal((await prime.json()).version, 'task4-measurement');
  const primingLatencyMs = performance.now() - primingStart;
  assert.equal(readdirSync(join(dataDir, 'runs')).filter(name => name.endsWith('.facts.json')).length, 0);
  // Diagnostics only: name the main-thread calls and GC pauses inside each sample.
  const { TranscriptFactsIndex } = await import(new URL('runs/transcript-facts.js', runtime.url));
  const { TranscriptFactsQueue } = await import(new URL('runs/transcript-facts-queue.js', runtime.url));
  const { RunQueriesTopic } = await import(new URL('runs/run-queries.js', runtime.url));
  const calls = [];
  unhookCalls = hookCalls([[RunQueriesTopic.prototype, 'listConversationRootIds'], [RunQueriesTopic.prototype, 'listFamilyRunIds'],
    [RunQueriesTopic.prototype, 'listRunIds'], [TranscriptFactsIndex.prototype, 'warm'], [TranscriptFactsIndex.prototype, 'peek'],
    [TranscriptFactsIndex.prototype, 'accept'], [TranscriptFactsIndex.prototype, 'persist'],
    [TranscriptFactsQueue.prototype, 'start'], [TranscriptFactsQueue.prototype, 'createWorker']], calls);
  const gcPauses = [];
  gcObserver = new PerformanceObserver(list => { for (const entry of list.getEntries()) gcPauses.push(entry); });
  gcObserver.observe({ entryTypes: ['gc'] });
  threadWatch = await startThreadWatch();
  // Watch every sample: any one over the budget names what the main thread waited in.
  threadWatch?.watch(true);
  const start = performance.now();
  let end;
  let warming;
  const samples = [];
  const pauseMs = 5;
  // Each sample after the first also covers the pause before its request, so blocking
  // between requests is measured too; the pause is loop idle time, which blockingBudget excludes.
  let pauseStart;
  for (;;) {
    const measurementStart = pauseStart ?? timingSnapshot();
    const plannedMs = pauseStart ? pauseMs : 0;
    const requestStart = performance.now();
    const pendingResponse = fetch(endpoint, { signal: AbortSignal.timeout(2_000) });
    // The first request includes synchronous project-open work too.
    if (!store) {
      ({ store, timing: openTiming } = timedOpen(RunStore, dataDir));
      warming = store.transcriptFacts.factsWarmIdle().then(() => { end = performance.now(); });
    }
    const response = await pendingResponse;
    assert.equal(response.status, 200);
    assert.equal((await response.json()).version, 'task4-measurement');
    const requestEnd = performance.now();
    // Include EVERY request begun while cold warm-up was active, even one ending after it.
    const measurement = timingDelta(measurementStart, timingSnapshot());
    samples.push({ fromMs: measurementStart.at - start, startMs: requestStart - start, endMs: requestEnd - start,
      latencyMs: requestEnd - requestStart, plannedMs, ...measurement, ...blockingBudget(measurement) });
    if (end !== undefined) break;
    pauseStart = timingSnapshot();
    await delay(pauseMs);
  }
  threadWatch?.watch(false);
  await warming;
  unhookCalls();
  const waits = (await threadWatch?.stop()) ?? [];
  threadWatch = undefined;
  const firstFrom = start + samples[0].fromMs;
  const firstSampleWaits = waits.filter(entry => entry.at >= firstFrom && entry.at < firstFrom + samples[0].elapsedMs);
  for (const entry of gcObserver.takeRecords()) gcPauses.push(entry);
  gcObserver.disconnect();
  attachWaitsOverBudget(samples, waits, BUDGET_MS, sample => [start + sample.fromMs, start + sample.fromMs + sample.elapsedMs]);
  for (const sample of samples) {
    const from = start + sample.fromMs;
    const to = from + sample.elapsedMs;
    const gc = gcPauses.filter(entry => entry.startTime >= from && entry.startTime < to);
    Object.assign(sample, { calls: callsWithin(calls, from, to),
      gc: { count: gc.length, durationMs: gc.reduce((sum, entry) => sum + entry.duration, 0) } });
  }
  assert.ok(samples.length > 0, 'health requests must overlap cold warming');
  assert.ok(samples.every(sample => sample.fromMs < end - start && sample.endMs > 0));
  // Keep first-open and repeated-open costs separate. Reopening must not rescan clean history.
  const reopenTimings = Array.from({ length: 3 }, () => {
    const reopened = timedOpen(RunStore, dataDir);
    const closeStart = timingSnapshot();
    reopened.store.close();
    return { ...reopened.timing, closeTiming: timingDelta(closeStart, timingSnapshot()) };
  });
  const result = { kind: 'transcript-facts-http-health', openTiming, reopenTimings, runtime: runtime.url.href,
    endpoint: '/api/v1/health', scenario: 'already-listening server during cold project open', primingLatencyMs,
    ...verifyFacts(dataDir, fixtures, store), durationMs: end - start,
    maxBlockingMs: Math.max(...samples.map(sample => sample.blockingMs)),
    maxMainThreadCpuMs: Math.max(...samples.map(sample => sample.mainThreadCpuMs)),
    maxLoopIdleMs: Math.max(...samples.map(sample => sample.loopIdleMs)),
    firstSampleWaits: summarizeWaits(firstSampleWaits), firstSampleWaitTrace: firstSampleWaits.slice(0, 300),
    sampleCount: samples.length, maxLatencyMs: Math.max(...samples.map(sample => sample.latencyMs)), samples };
  console.log(JSON.stringify(result));
  // Exclude run-queue delay and loop idle time: a response that waits on the thread pool, a worker
  // or the kernel is latency (kept in maxLatencyMs), not main-thread blocking. Synchronous work counts.
  assert.ok(result.maxBlockingMs < BUDGET_MS, `max health blocking ${result.maxBlockingMs.toFixed(3)}ms must be <${BUDGET_MS}ms`);
} finally {
  clearTimeout(watchdog);
  unhookCalls?.();
  gcObserver?.disconnect();
  await threadWatch?.stop();
  let cleanupTimer;
  try {
    if (server) await Promise.race([server.shutdownForRestart(), new Promise((_, reject) => {
      cleanupTimer = setTimeout(() => reject(new Error('server cleanup timed out')), 5_000);
    })]);
  } finally {
    clearTimeout(cleanupTimer);
    store?.close();
    bootStore?.close();
    rmSync(root, { recursive: true, force: true });
  }
}
