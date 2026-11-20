import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CiPrIdentity, CiWait } from '@open-mercato/cezar-contract';
import { CiGithubError, GithubCiClient, type GithubCheck, type GithubChecksObservation } from './github.ts';
import { CiProgressRegistry } from './progress.ts';
import { CI_PROBE_MS, CiWatcherSupervisor } from './supervisor.ts';

/**
 * The CI watcher feeds the activity view's check progress (spec 2026-11-05-live-activity-view,
 * CI check progress). Every read of the head and checks publishes its rows, at the start and at each
 * 30 s probe (hearsay-tools/squawk#3972); the entry goes when the watch ends.
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

const identity: CiPrIdentity = {prUrl: 'https://github.com/org/repo/pull/12', repository: 'org/repo', prNumber: 12, headSha: 'a'.repeat(40)};
const wait = (): CiWait => ({...identity, id: crypto.randomUUID(), generation: 'g', turnId: 't', timeoutSeconds: 1800, until: 'checks', wakeOnConflict: true,
  registeredAt: new Date().toISOString(), deadline: new Date(Date.now() + 1_800_000).toISOString(), phase: 'registered'});
const row = (name: string, bucket: GithubCheck['bucket']): GithubCheck => ({name, state: bucket === 'pass' ? 'SUCCESS' : 'PENDING', link: '', bucket});
const pending = [row('build', 'pending')];
const passed = [row('build', 'pass')];

/** A GitHub that answers from scripts and logs each call. The last script entry repeats. */
class ScriptedGithub extends GithubCiClient {
  calls: string[] = [];
  heads: string[] = [identity.headSha];
  active: boolean[] = [false];
  /** Each read of the head and checks, in order: its rows, or an error to throw. */
  reads: Array<GithubCheck[] | Error> = [pending];
  private finish: (() => void) | undefined;
  private next<T>(script: T[], name: string): T { const count = this.calls.filter(call => call === name).length; return script[Math.min(count - 1, script.length - 1)]!; }
  override async observe(): Promise<GithubChecksObservation> {
    this.calls.push('observe');
    const read = this.next(this.reads, 'observe');
    if (read instanceof Error) throw read;
    return {headSha: this.next(this.heads, 'observe'), mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', checks: read};
  }
  override async workflowRuns() { this.calls.push('runs'); return {active: this.next(this.active, 'runs'), failures: []}; }
  override watch(_pr: CiPrIdentity, signal: AbortSignal): Promise<void> {
    this.calls.push('watch');
    return new Promise((resolve, reject) => {
      this.finish = resolve;
      signal.addEventListener('abort', () => reject(signal.reason), {once: true});
    });
  }
  /** `gh pr checks --watch` exits. */
  finishWatch(): void { this.finish!(); }
  count(name: string): number { return this.calls.filter(call => call === name).length; }
}

const services: CiWatcherSupervisor[] = [];
const controllers: AbortController[] = [];
function start(github: ScriptedGithub) {
  const progress = new CiProgressRegistry();
  const service = new CiWatcherSupervisor({github, progress}); services.push(service);
  const controller = new AbortController(); controllers.push(controller);
  const request = wait();
  const result = service.watch(request, controller.signal);
  const state = {settled: false};
  void result.then(() => { state.settled = true; });
  return {service, controller, request, result, state, progress};
}
afterEach(() => { for (const s of services.splice(0)) s.close(); for (const c of controllers.splice(0)) c.abort(); vi.useRealTimers(); vi.restoreAllMocks(); });
// One tick past a timer, so the async steps it starts finish on the fake clock.
const tick = () => vi.advanceTimersByTimeAsync(1);
const probe = () => vi.advanceTimersByTimeAsync(CI_PROBE_MS);

describe('the check progress of a CI wait', () => {
  it('each 30 s probe reads the head and checks in one query and publishes the rows', async () => {
    vi.useFakeTimers(); const github = new ScriptedGithub();
    github.reads = [pending, [row('build', 'pass'), row('lint', 'pending')]];
    const {request, progress, state} = start(github);
    await tick();
    expect(github.calls).toEqual(['observe', 'watch']);
    expect(progress.read(request.id)?.counts).toMatchObject({pending: 1, pass: 0});
    await probe();
    expect(github.calls).toEqual(['observe', 'watch', 'observe']);
    expect(progress.read(request.id)?.counts).toMatchObject({pending: 1, pass: 1});
    expect(state.settled).toBe(false);
  });

  it('publishes the empty first read while a workflow runs, then each later read', async () => {
    vi.useFakeTimers(); const github = new ScriptedGithub();
    github.active = [true, false]; github.reads = [[], pending, passed];
    const {request, progress, result} = start(github);
    await tick();
    expect(progress.read(request.id)).toEqual({checks: [], counts: {pass: 0, fail: 0, pending: 0, skipping: 0, cancel: 0}});
    await probe();
    expect(progress.read(request.id)?.checks).toEqual([{name: 'build', bucket: 'pending'}]);
    await probe();
    expect(await result).toMatchObject({outcome: 'passed', totalChecks: 1});
  });

  it('a transient read failure keeps the last progress, and the retry settles the wait', async () => {
    vi.useFakeTimers(); const github = new ScriptedGithub();
    github.reads = [pending, new CiGithubError('command_failed', 'GitHub query failed; check connectivity and GitHub availability, then retry.', true), passed];
    const {request, progress, result, state} = start(github);
    await tick();
    await probe();
    expect(state.settled).toBe(false);
    expect(progress.read(request.id)?.checks).toEqual([{name: 'build', bucket: 'pending'}]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await result).toMatchObject({outcome: 'passed', totalChecks: 1});
    expect(progress.read(request.id)).toBeUndefined();
  });

  it('wait resolves: the result has its checks and totalChecks, and the progress entry is removed', async () => {
    vi.useFakeTimers(); const github = new ScriptedGithub();
    github.reads = [pending, passed];
    const {request, progress, result} = start(github);
    await tick();
    github.finishWatch();
    expect(await result).toMatchObject({outcome: 'passed', totalChecks: 1, checks: [{name: 'build', state: 'SUCCESS'}]});
    expect(progress.read(request.id)).toBeUndefined();
  });

  it.each([
    ['the wait is cancelled', ({controller}: ReturnType<typeof start>) => controller.abort()],
    ['the service closes', ({service}: ReturnType<typeof start>) => service.close()],
  ])('%s: the progress entry is removed', async (_name, stop) => {
    vi.useFakeTimers(); const github = new ScriptedGithub();
    const watch = start(github);
    await tick();
    expect(watch.progress.read(watch.request.id)).toBeDefined();
    stop(watch);
    expect(await watch.result).toMatchObject({outcome: 'cancelled'});
    expect(watch.progress.read(watch.request.id)).toBeUndefined();
  });
});
