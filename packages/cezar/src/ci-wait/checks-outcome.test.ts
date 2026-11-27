import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CiPrIdentity, CiWait } from '@open-mercato/cezar-contract';
import { CiGithubError, GithubCiClient, type GithubCheck, type GithubChecksObservation, type GithubWorkflowRuns } from './github.ts';
import { CI_DISCOVERY_MS, CI_PROBE_MS, CiWatcherSupervisor } from './supervisor.ts';

/**
 * What a checks wait reports for the head's real state (hearsay-tools/squawk#3972): only required
 * checks decide a cancellation or an early failure, a concluded check is settled whatever its
 * status, a workflow run with no job or a failure is never `passed`, and a head the caller just
 * pushed is not a changed head.
 */

// Vitest does not virtualize node:timers/promises; keep AbortSignal semantics on the fake clock.
vi.mock('node:timers/promises', () => ({setTimeout: (ms: number, value: unknown, options: {signal: AbortSignal}) => new Promise((resolve, reject) => {
  const signal = options.signal;
  if (signal.aborted) { reject(signal.reason); return; }
  const done = () => { signal.removeEventListener('abort', abort); resolve(value); };
  const timer = setTimeout(done, ms);
  const abort = () => { clearTimeout(timer); reject(signal.reason); };
  signal.addEventListener('abort', abort, {once: true});
})}));

const head = 'a'.repeat(40);
const pushed = 'c'.repeat(40);
const identity: CiPrIdentity = {prUrl: 'https://github.com/org/repo/pull/12', repository: 'org/repo', prNumber: 12, headSha: head};
const wait = (over: Partial<CiWait> = {}): CiWait => ({...identity, id: crypto.randomUUID(), generation: 'g', turnId: 't', timeoutSeconds: 1800, until: 'checks',
  wakeOnConflict: true, registeredAt: new Date().toISOString(), deadline: new Date(Date.now() + 1_800_000).toISOString(), phase: 'registered', ...over});
const check = (name: string, bucket: GithubCheck['bucket'], over: Partial<GithubCheck> = {}): GithubCheck =>
  ({name, state: {pass: 'SUCCESS', fail: 'FAILURE', cancel: 'CANCELLED', skipping: 'SKIPPED', pending: 'IN_PROGRESS'}[bucket], link: '', bucket, required: false, ...over});

class Github extends GithubCiClient {
  heads: string[] = [head];
  rows: GithubCheck[] = [];
  runs: GithubWorkflowRuns = {active: false, failures: []};
  reads = 0;
  override async observe(): Promise<GithubChecksObservation> {
    const headSha = this.heads[Math.min(this.reads++, this.heads.length - 1)]!;
    return {headSha, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', checks: this.rows};
  }
  override async workflowRuns(): Promise<GithubWorkflowRuns> { return this.runs; }
  override watch(_pr: CiPrIdentity, signal: AbortSignal): Promise<void> {
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), {once: true}));
  }
}
const services: CiWatcherSupervisor[] = [];
const controllers: AbortController[] = [];
function start(github: Github, over: Partial<CiWait> = {}) {
  const service = new CiWatcherSupervisor({github}); services.push(service);
  const controller = new AbortController(); controllers.push(controller);
  const result = service.watch(wait(over), controller.signal);
  const state = {settled: false};
  void result.then(() => { state.settled = true; });
  return {result, controller, state};
}
afterEach(() => { for (const s of services.splice(0)) s.close(); for (const c of controllers.splice(0)) c.abort(); vi.useRealTimers(); vi.restoreAllMocks(); });

it.each([
  ['a superseded or optional cancelled check beside a passed required one', [check('signal', 'cancel'), check('build', 'pass', {required: true})], 'passed'],
  ['a cancelled required check', [check('signal', 'cancel'), check('build', 'cancel', {required: true})], 'cancelled'],
  ['a cancelled check when no check is required', [check('signal', 'cancel'), check('build', 'pass')], 'cancelled'],
  ['a failed check that is not required', [check('lint', 'fail'), check('build', 'pass', {required: true})], 'failed'],
  ['only optional cancelled and skipped checks beside a skipped required one', [check('signal', 'cancel'), check('build', 'skipping', {required: true})], 'skipped'],
  ['a concluded check whose status stayed in progress', [check('verify', 'pass', {state: 'SUCCESS', stale: true})], 'passed'],
] as const)('settled checks: %s → %s', async (_name, rows, outcome) => {
  const github = new Github(); github.rows = [...rows];
  expect(await start(github).result).toMatchObject({outcome});
});

it('a required failure ends the wait at once while other checks still run', async () => {
  const github = new Github(); github.rows = [check('build', 'fail', {required: true}), check('e2e', 'pending', {required: true})];
  expect(await start(github).result).toMatchObject({outcome: 'failed', totalChecks: 2});
});

it('a failure that is not required waits for the required checks', async () => {
  vi.useFakeTimers();
  const github = new Github(); github.rows = [check('lint', 'fail'), check('build', 'pending', {required: true})];
  const {result, state} = start(github);
  await vi.advanceTimersByTimeAsync(CI_PROBE_MS);
  expect(state.settled).toBe(false);
  github.rows = [check('lint', 'fail'), check('build', 'pass', {required: true})];
  await vi.advanceTimersByTimeAsync(CI_PROBE_MS);
  expect(await result).toMatchObject({outcome: 'failed'});
});

it('a workflow whose newest run created no job ends as startup_failure, not passed', async () => {
  // hearsay-tools/squawk#3738: CI and PR Readiness ended startup_failure; only optional checks were on the head.
  const github = new Github(); github.rows = [check('Strict cold-history timing', 'pass')];
  github.runs = {active: false, failures: [{id: 43906943124, workflow: 'CI', conclusion: 'startup_failure'}, {id: 7, workflow: 'Lint', conclusion: 'failure'}]};
  const result = await start(github).result;
  expect(result).toMatchObject({outcome: 'startup_failure', totalChecks: 1});
  expect(result.diagnostic).toContain('Workflow "CI" run 43906943124 ended in startup_failure and created no job');
});

it('a startup_failure on a head with no checks is reported, not left to no_checks', async () => {
  const github = new Github();
  github.runs = {active: false, failures: [{id: 9, workflow: 'CI', conclusion: 'startup_failure'}]};
  expect(await start(github).result).toMatchObject({outcome: 'startup_failure', totalChecks: 0});
});

it('a workflow run that concluded failure turns green checks into failed', async () => {
  const github = new Github(); github.rows = [check('build', 'pass', {required: true})];
  github.runs = {active: false, failures: [{id: 5, workflow: 'Review signal', conclusion: 'failure'}]};
  const result = await start(github).result;
  expect(result).toMatchObject({outcome: 'failed'});
  expect(result.diagnostic).toBe('Workflow "Review signal" run 5 concluded failure on this head.');
});

it('a deadline observation names each stale check record', async () => {
  vi.useFakeTimers();
  const deadline = new AbortController();
  vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(deadline.signal);
  const github = new Github(); github.rows = [check('Verify exact queue CI evidence', 'pass', {stale: true}), check('e2e', 'pending')];
  const {result} = start(github);
  await vi.advanceTimersByTimeAsync(1);
  deadline.abort();
  expect(await result).toMatchObject({outcome: 'deadline',
    diagnostic: 'Stale check records (a conclusion, but a status other than completed): Verify exact queue CI evidence.'});
});

it('a deadline after failed reads names both the last query error and the stale records', async () => {
  vi.useFakeTimers();
  const deadline = new AbortController();
  vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(deadline.signal);
  const github = new Github(); github.rows = [check('verify', 'pass', {stale: true}), check('e2e', 'pending')];
  const read = github.observe.bind(github);
  let failing = false;
  github.observe = async () => { if (failing) throw new CiGithubError('command_failed', 'GitHub query failed.', true); return read(); };
  const {result} = start(github);
  await vi.advanceTimersByTimeAsync(1);
  failing = true;
  await vi.advanceTimersByTimeAsync(CI_PROBE_MS);
  deadline.abort();
  expect(await result).toMatchObject({outcome: 'deadline',
    diagnostic: 'command_failed: GitHub query failed. Stale check records (a conclusion, but a status other than completed): verify.'});
});

it('keeps a deadline with a query error and many stale records within the diagnostic limit', async () => {
  vi.useFakeTimers();
  const deadline = new AbortController();
  vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(deadline.signal);
  const github = new Github();
  github.rows = [...Array.from({length: 20}, (_, i) => check(`${'x'.repeat(226)}${String(i).padStart(3, '0')}`, 'pass', {stale: true})), check('e2e', 'pending')];
  const read = github.observe.bind(github);
  let failing = false;
  github.observe = async () => { if (failing) throw new CiGithubError('command_failed', 'GitHub query failed; check connectivity and GitHub availability, then retry.', true); return read(); };
  const {result} = start(github);
  await vi.advanceTimersByTimeAsync(1);
  failing = true;
  await vi.advanceTimersByTimeAsync(CI_PROBE_MS);
  deadline.abort();
  const observed = await result;
  expect(observed.outcome).toBe('deadline');
  expect(observed.diagnostic).toMatch(/^command_failed: .* Stale check records .* more\.$/);
  expect(Buffer.byteLength(observed.diagnostic!)).toBeLessThanOrEqual(4096);
});

it('a pushed head GitHub does not show yet keeps the wait open, then settles on that head', async () => {
  vi.useFakeTimers();
  const github = new Github(); github.heads = [head, head, pushed]; github.rows = [check('build', 'pass')];
  const {result, state} = start(github, {headSha: pushed, callerHead: true});
  await vi.advanceTimersByTimeAsync(CI_PROBE_MS);
  expect(state.settled).toBe(false);
  await vi.advanceTimersByTimeAsync(CI_PROBE_MS);
  expect(await result).toMatchObject({outcome: 'passed', headSha: pushed});
});

it('a pushed head GitHub never shows within the discovery window ends as head_changed', async () => {
  vi.useFakeTimers();
  const github = new Github(); github.rows = [check('build', 'pass')];
  const {result} = start(github, {headSha: pushed, callerHead: true});
  await vi.advanceTimersByTimeAsync(CI_DISCOVERY_MS + CI_PROBE_MS);
  expect(await result).toMatchObject({outcome: 'head_changed', headSha: pushed, observedHeadSha: head});
});

it('once GitHub has shown the pushed head, a later head is head_changed at once', async () => {
  vi.useFakeTimers();
  const github = new Github(); github.heads = [pushed, 'b'.repeat(40)]; github.rows = [check('build', 'pending')];
  const {result} = start(github, {headSha: pushed, callerHead: true});
  await vi.advanceTimersByTimeAsync(CI_PROBE_MS);
  expect(await result).toMatchObject({outcome: 'head_changed', observedHeadSha: 'b'.repeat(40)});
});

it('without a caller head, a different head is head_changed on the first read', async () => {
  const github = new Github(); github.heads = ['b'.repeat(40)];
  expect(await start(github).result).toMatchObject({outcome: 'head_changed', observedHeadSha: 'b'.repeat(40)});
});

describe('the checks scope (hearsay-tools/squawk#4392)', () => {
  const required = {checks: 'required' as const};
  const status = (name: string, bucket: GithubCheck['bucket'], over: Partial<GithubCheck> = {}) =>
    check(name, bucket, {state: {pass: 'SUCCESS', fail: 'FAILURE', cancel: 'ERROR', skipping: 'SKIPPED', pending: 'PENDING'}[bucket], ...over});

  it('settles on the required checks while a status that is not required stays pending, and names it', async () => {
    const github = new Github(); github.rows = [check('build', 'pass', {required: true}), status('pre-pr-review', 'pending')];
    expect(await start(github, required).result).toMatchObject({outcome: 'passed', totalChecks: 2,
      diagnostic: 'Not waited on, because they are not required: pre-pr-review (PENDING).'});
  });

  it('settles while a check run that is not required still runs, and ignores its active workflow', async () => {
    const github = new Github(); github.rows = [check('build', 'pass', {required: true}), check('benchmark', 'pending')];
    github.runs = {active: true, failures: []};
    expect(await start(github, required).result).toMatchObject({outcome: 'passed',
      diagnostic: 'Not waited on, because they are not required: benchmark (IN_PROGRESS).'});
  });

  it('takes the outcome from the required checks and names a failure that is not required', async () => {
    const github = new Github(); github.rows = [check('lint', 'fail'), check('build', 'pass', {required: true})];
    github.runs = {active: false, failures: [{id: 5, workflow: 'Lint', conclusion: 'failure'}]};
    expect(await start(github, required).result).toMatchObject({outcome: 'passed',
      diagnostic: 'Not waited on, because they are not required: lint (FAILURE).'});
  });

  it('still reports a workflow that created no job', async () => {
    const github = new Github(); github.rows = [check('build', 'pass', {required: true})];
    github.runs = {active: false, failures: [{id: 9, workflow: 'CI', conclusion: 'startup_failure'}]};
    expect(await start(github, required).result).toMatchObject({outcome: 'startup_failure'});
  });

  it.each([
    ['a required pending status', [check('build', 'pass', {required: true}), status('deploy', 'pending', {required: true})], required],
    ['a required pending check run', [check('build', 'pending', {required: true}), status('pre-pr-review', 'pass')], required],
    ['a pending status that is not required, with checks "all"', [check('build', 'pass', {required: true}), status('pre-pr-review', 'pending')], {checks: 'all' as const}],
    ['a pending check run that is not required, with checks "all"', [check('build', 'pass', {required: true}), check('benchmark', 'pending')], {checks: 'all' as const}],
  ] as const)('keeps the wait open for %s', async (_name, rows, over) => {
    vi.useFakeTimers();
    const github = new Github(); github.rows = [...rows];
    const {result, state} = start(github, over);
    await vi.advanceTimersByTimeAsync(CI_PROBE_MS);
    expect(state.settled).toBe(false);
    github.rows = rows.map(row => ({...row, bucket: 'pass' as const, state: 'SUCCESS'}));
    await vi.advanceTimersByTimeAsync(CI_PROBE_MS);
    expect(await result).toMatchObject({outcome: 'passed'});
  });

  it('waits on every check when none is required, and says so', async () => {
    vi.useFakeTimers();
    const github = new Github(); github.rows = [status('ci/jenkins', 'pending')];
    const {result, state} = start(github, required);
    await vi.advanceTimersByTimeAsync(CI_PROBE_MS);
    expect(state.settled).toBe(false);
    github.rows = [status('ci/jenkins', 'pass')];
    await vi.advanceTimersByTimeAsync(CI_PROBE_MS);
    expect(await result).toMatchObject({outcome: 'passed', diagnostic: 'No check is required on this PR, so this wait covered every check.'});
  });

  it('keeps a long list of checks that are not required within the diagnostic limit', async () => {
    const github = new Github();
    github.rows = [check('build', 'pass', {required: true}), ...Array.from({length: 30}, (_, i) => status(`${'s'.repeat(240)}${i}`, 'pending'))];
    const observed = await start(github, required).result;
    expect(observed.diagnostic).toMatch(/^Not waited on, because they are not required: .* more\.$/);
    expect(Buffer.byteLength(observed.diagnostic!)).toBeLessThanOrEqual(4096);
  });
});
