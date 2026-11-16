import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentRunResult, AgentSession } from './agent-runner.ts';
import { DESCRIBED_EVENTS, Recorder, until } from './seam-contract.testkit.ts';

/** A session stub: only what the recorder reads. */
function fakeSession(result: Promise<AgentRunResult>, open = false): AgentSession {
  return { result, open, holdsHumanInput: () => true, heldHumanInputCount: () => 1 } as unknown as AgentSession;
}

describe('seam contract waits (hearsay-tools/squawk#3734)', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('fails at once with the result of a session that ends before the condition', async () => {
    const recorder = new Recorder();
    recorder.mark('sent');
    recorder.watch(fakeSession(Promise.reject(new Error('mock exited with code 1'))));
    // bound: far past the test timeout, so only the session's end can fail the wait in time.
    const failure = await until(recorder, () => false, 3_600_000).then(() => undefined, (error: Error) => error);
    expect(failure?.message).toMatch(/^the session ended before \(\) => false: its result rejected: mock exited with code 1/);
    expect(failure?.message).toContain('session.open=false held=1');
    expect(failure?.message).toContain('0 mark sent');
  });

  it('prints the session state and the timeline when the hang guard expires', async () => {
    vi.useFakeTimers();
    const recorder = new Recorder();
    recorder.mark('sent');
    recorder.watch(fakeSession(new Promise<AgentRunResult>(() => undefined)));
    // bound: the hang guard is the subject here; fake timers expire it, no real time passes.
    const failure = until(recorder, () => false, 100).then(() => undefined, (error: Error) => error);
    await vi.advanceTimersByTimeAsync(200);
    const message = (await failure)?.message ?? '';
    expect(message).toMatch(/^waitFor timed out after \d+ms: \(\) => false/);
    expect(message).toContain('session.open=false held=1');
    expect(message).toContain('0 mark sent');
  });

  it('returns once the condition holds, even after the session ended', async () => {
    const recorder = new Recorder();
    recorder.watch(fakeSession(Promise.resolve({ text: '', toolCalls: [], tokensUsed: 0 })));
    await Promise.resolve();
    await expect(until(recorder, () => true)).resolves.toBeUndefined();
  });

  it('names an error that leaves the session open when the hang guard expires', async () => {
    vi.useFakeTimers();
    const recorder = new Recorder();
    recorder.watch(fakeSession(new Promise<AgentRunResult>(() => undefined), true));
    recorder.onEvent({ v1: { type: 'error', message: 'prompt rejected: owned turn rejected' } });
    recorder.onEvent({ v1: { type: 'note', message: `pi: ${'x'.repeat(500)}` } });
    // bound: the hang guard is the subject here; fake timers expire it, no real time passes.
    const failure = until(recorder, () => false, 100).then(() => undefined, (error: Error) => error);
    await vi.advanceTimersByTimeAsync(200);
    const message = (await failure)?.message ?? '';
    expect(message).toContain('session.open=true held=1');
    expect(message).toContain('0 v1 error "prompt rejected: owned turn rejected"');
    // One message is bounded: the note keeps its first 200 characters.
    expect(message).toContain(`1 v1 note "pi: ${'x'.repeat(196)}"`);
  });

  it('lists only the last events, after a count of those dropped', async () => {
    vi.useFakeTimers();
    const recorder = new Recorder();
    recorder.watch(fakeSession(new Promise<AgentRunResult>(() => undefined), true));
    const total = DESCRIBED_EVENTS + 50;
    for (let i = 0; i < total; i++) recorder.mark(`m${i}`);
    // bound: the hang guard is the subject here; fake timers expire it, no real time passes.
    const failure = until(recorder, () => false, 100).then(() => undefined, (error: Error) => error);
    await vi.advanceTimersByTimeAsync(200);
    const lines = ((await failure)?.message ?? '').split('\n');
    expect(lines).toContain('(50 earlier events not shown)');
    expect(lines).not.toContain('49 mark m49');
    expect(lines).toContain('50 mark m50');
    expect(lines).toContain(`${total - 1} mark m${total - 1}`);
    expect(lines.filter(line => / mark m\d+$/.test(line))).toHaveLength(DESCRIBED_EVENTS);
  });
});
