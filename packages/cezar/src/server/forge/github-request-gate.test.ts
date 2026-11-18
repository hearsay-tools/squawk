import { afterEach, describe, expect, it, vi } from 'vitest';
import { GithubCiClient, type CiCommandResult } from '../../ci-wait/github.ts';
import { GithubPoller } from '../../automations/github-poller.ts';
import { lookupMergedPullRequests } from './github.ts';
import {
  GITHUB_PAUSE_MAX_MS, GITHUB_PAUSE_MIN_MS, GITHUB_REQUEST_LIMIT, GithubRateLimitedError, GithubRequestGate,
  githubRequestGate, isGithubRateLimit,
} from './github-request-gate.ts';

const gh = vi.hoisted(() => ({ calls: [] as string[][], reply: (_args: string[]): Promise<string> => Promise.resolve('') }));
vi.mock('./github-cli.ts', async original => ({
  ...await original<typeof import('./github-cli.ts')>(),
  gh: (_root: string, args: string[]) => { gh.calls.push(args); return gh.reply(args); },
}));

/** Let queued promise work settle. */
const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const rateLimit = () => Object.assign(new Error('Command failed: gh api graphql'), { stderr: 'HTTP 403: API rate limit exceeded for user ID 1.' });

/** The PR wait's client on the shared gate; gh replies are held until the test releases them. */
class HeldCi extends GithubCiClient {
  readonly held: Array<() => void> = [];
  calls = 0;
  constructor() { super({ gate: githubRequestGate }); }
  protected override runCommand(): Promise<CiCommandResult> {
    this.calls++;
    return new Promise(resolve => this.held.push(() => resolve({ code: 0, stdout: JSON.stringify({ total_count: 0, workflow_runs: [] }), stderr: '' })));
  }
}
const pr = { prUrl: 'https://github.com/o/r/pull/1', repository: 'o/r', prNumber: 1, headSha: 'a'.repeat(40) };
const candidate = { eventId: 'e', event: 'issue.opened' as const, timestamp: '2026-11-18T00:00:00.000Z', tieBreaker: 'I', repo: 'o/r', nodeId: 'I', number: 7, title: 'Issue', url: 'https://github.com/o/r/issues/7', author: 'a', assignees: [], labels: [] };
const definition = { filters: {} } as never;
const signal = () => new AbortController().signal;

afterEach(() => { vi.useRealTimers(); gh.calls.length = 0; });

describe('the three pollers share one gate', () => {
  it('queues automation and archive-on-merge requests behind PR-wait queries that hold every permit', async () => {
    const ci = new HeldCi();
    const queries = Array.from({ length: GITHUB_REQUEST_LIMIT }, () => ci.hasActiveRuns(pr, signal()));
    await settle();
    expect(ci.calls).toBe(GITHUB_REQUEST_LIMIT);

    let answerAutomation = () => {};
    const automation = vi.fn(() => new Promise<string>(resolve => { answerAutomation = () => resolve(JSON.stringify({ state: 'open', labels: [] })); }));
    const labels = new GithubPoller({ run: automation }).matchesCurrentLabels(candidate, definition);
    gh.reply = async () => JSON.stringify({ data: { repository: { nameWithOwner: 'o/r', pr101: null } } });
    const archive = lookupMergedPullRequests('/repo', [{ owner: 'o', repo: 'r', number: 101 }], signal());
    await settle();
    expect(automation).not.toHaveBeenCalled();
    expect(gh.calls).toHaveLength(0);

    // Permits pass in arrival order: the automation request first, then archive-on-merge.
    ci.held.shift()!();
    await settle();
    expect(automation).toHaveBeenCalledTimes(1);
    expect(gh.calls).toHaveLength(0);
    ci.held.shift()!();
    await settle();
    expect(gh.calls).toHaveLength(1);
    answerAutomation();
    await expect(labels).resolves.toBe(true);
    await expect(archive).resolves.toEqual([]);
    expect(gh.calls).toHaveLength(1);
    for (const release of ci.held.splice(0)) release();
    await Promise.all(queries);
  });

  it('pauses automations and the PR wait when archive-on-merge meets a rate limit, until the pause ends', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    gh.reply = async () => { throw rateLimit(); };
    const archive = lookupMergedPullRequests('/repo', [{ owner: 'o', repo: 'r', number: 102 }], signal());
    await expect(archive).rejects.toBeInstanceOf(GithubRateLimitedError);
    expect(githubRequestGate.pausedUntil()).toBe(Date.now() + GITHUB_PAUSE_MIN_MS);

    const automation = vi.fn(async () => JSON.stringify({ state: 'open', labels: [] }));
    await expect(new GithubPoller({ run: automation }).matchesCurrentLabels(candidate, definition)).rejects.toBeInstanceOf(GithubRateLimitedError);
    expect(automation).not.toHaveBeenCalled();

    const ci = new HeldCi();
    const query = ci.hasActiveRuns(pr, signal());
    await vi.advanceTimersByTimeAsync(GITHUB_PAUSE_MIN_MS - 1);
    expect(ci.calls).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(ci.calls).toBe(1);
    ci.held.shift()!();
    await expect(query).resolves.toBe(false);
    expect(githubRequestGate.pausedUntil()).toBeUndefined();
  });
});

describe('GithubRequestGate', () => {
  it.each([
    ['HTTP 403: API rate limit exceeded for user', true],
    ['HTTP 403: You have exceeded a secondary rate limit.', true],
    ['HTTP 429: Too many requests', true],
    ['HTTP 403: Resource not accessible by integration', false],
    ['HTTP 401: Bad credentials', false],
  ])('reads %j as a rate limit: %s', (text, expected) => {
    expect(isGithubRateLimit(text)).toBe(expected);
  });

  it('doubles the pause for each further rate limit up to the maximum, and resets it after a reply', () => {
    let now = 0;
    const gate = new GithubRequestGate({ now: () => now });
    const pauses: number[] = [];
    for (let i = 0; i < 6; i++) { gate.record(true); pauses.push(gate.pausedUntil()! - now); now = gate.pausedUntil()!; }
    expect(pauses).toEqual([1, 2, 4, 8, 15, 15].map(minutes => Math.min(minutes * GITHUB_PAUSE_MIN_MS, GITHUB_PAUSE_MAX_MS)));
    gate.record(false);
    gate.record(true);
    expect(gate.pausedUntil()! - now).toBe(GITHUB_PAUSE_MIN_MS);
  });

  it('does not extend a running pause for replies to requests already in flight', () => {
    let now = 0;
    const gate = new GithubRequestGate({ now: () => now });
    gate.record(true);
    now = 1_000;
    gate.record(true);
    expect(gate.pausedUntil()).toBe(GITHUB_PAUSE_MIN_MS);
  });

  it('does not read the command line in an error message as a rate limit', async () => {
    const gate = new GithubRequestGate();
    const failure = Object.assign(new Error('Command failed: gh search issues label:rate-limit'), { stderr: 'HTTP 502' });
    await expect(gate.run(async () => { throw failure; })).rejects.toBe(failure);
    expect(gate.pausedUntil()).toBeUndefined();
  });

  it('records a rate-limited reply the request returns', async () => {
    const gate = new GithubRequestGate();
    await expect(gate.run(async () => 'limited', { rateLimited: reply => reply === 'limited' })).resolves.toBe('limited');
    expect(gate.pausedUntil()).toBeDefined();
  });

  it('takes no permit for a request aborted while it waits out a pause', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const gate = new GithubRequestGate({ limit: 1 });
    gate.record(true);
    const abort = new AbortController();
    const waiting = gate.admit({ signal: abort.signal });
    abort.abort(new Error('stopped'));
    await expect(waiting).rejects.toThrow('stopped');
    await vi.advanceTimersByTimeAsync(GITHUB_PAUSE_MIN_MS);
    const release = await gate.admit();
    release();
  });

  it('lets a request that takes no permit run beside requests that hold every permit', async () => {
    const gate = new GithubRequestGate({ limit: 1 });
    const held = await gate.admit();
    const free = await gate.admit({ permit: false });
    free();
    held();
  });
});
