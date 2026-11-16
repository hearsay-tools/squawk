import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentRunResult, AgentSession } from './agent-runner.ts';
import { Recorder, until } from './seam-contract.testkit.ts';

/** A session stub: only what the recorder reads. */
function fakeSession(result: Promise<AgentRunResult>): AgentSession {
  return { result, open: false, holdsHumanInput: () => true, heldHumanInputCount: () => 1 } as unknown as AgentSession;
}

describe('seam contract waits (hearsay-tools/squawk#3734)', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('fails at once with the result of a session that ends before the condition', async () => {
    const recorder = new Recorder();
    recorder.mark('sent');
    recorder.watch(fakeSession(Promise.reject(new Error('mock exited with code 1'))));
    // The bound is far past the test timeout: only the session's end can fail the wait in time.
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
});
