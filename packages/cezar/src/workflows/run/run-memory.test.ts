import { describe, expect, it } from 'vitest';
import { RUN_STATUS, WAIT_KIND } from '@open-mercato/cezar-contract/test-factories.testkit';
import type { RunRecord } from '../../runs/store.ts';
import { RunMemory, runMemoryReleases } from './run-memory.ts';

const openWait = [{ kind: WAIT_KIND.timer }] as unknown as RunRecord['waits'];

describe('RunMemory', () => {
  it('opens a slot on the first write and releases it when its last field clears', () => {
    const memory = new RunMemory();
    expect(memory.holds('run')).toBe(false);
    memory.write('run', 'imageSeq', 3);
    memory.write('run', 'retainedNote', 'retained');
    expect(memory.read('run', 'imageSeq')).toBe(3);
    memory.write('run', 'imageSeq', undefined);
    expect(memory.holds('run')).toBe(true);
    memory.write('run', 'retainedNote', undefined);
    expect(memory.holds('run')).toBe(false);
    memory.write('other', 'namerKey', undefined);
    expect(memory.holds('other')).toBe(false);
  });

  it('forgets only what an execution held when the run leaves the active registry', () => {
    const memory = new RunMemory();
    memory.write('run', 'memoryPausing', true);
    memory.write('run', 'namerKey', 'key');
    memory.write('run', 'forceStarted', true);
    memory.write('run', 'workerStopped', true);
    memory.forgetExecution('run');
    expect([memory.read('run', 'memoryPausing'), memory.read('run', 'namerKey'), memory.read('run', 'forceStarted')]).toEqual([undefined, undefined, undefined]);
    expect(memory.read('run', 'workerStopped')).toBe(true);
    memory.forgetExecution('run');
    memory.write('run', 'workerStopped', undefined);
    expect(memory.holds('run')).toBe(false);
  });

  it('releases a run that ended and keeps one that may still go on', () => {
    const memory = new RunMemory();
    let asked = 0;
    const live = (value: boolean) => () => { asked += 1; return value; };
    memory.releaseIfEnded('none', { status: RUN_STATUS.done }, live(false));
    expect(asked).toBe(0);
    memory.write('run', 'imageSeq', 1);
    memory.releaseIfEnded('run', { status: RUN_STATUS.review }, live(false));
    memory.releaseIfEnded('run', { status: RUN_STATUS.done }, live(true));
    expect(memory.holds('run')).toBe(true);
    memory.releaseIfEnded('run', { status: RUN_STATUS.done }, live(false));
    expect(memory.holds('run')).toBe(false);
  });

  it('releases every slot on delete and on dispose', () => {
    const memory = new RunMemory();
    memory.write('a', 'imageSeq', 1);
    memory.write('b', 'deferredMessages', [{ content: [{ type: 'text', text: 'hi' }] }]);
    memory.release('a');
    expect(memory.holds('a')).toBe(false);
    memory.dispose();
    expect(memory.holds('b')).toBe(false);
  });

  it('a released run holds no run-scope liveness bound, and other runs keep theirs', () => {
    const memory = new RunMemory();
    for (const kind of ['wake-retry', 'wake-backoff', 'auto-resume', 'subagent-retry', 'inbox-claim', 'request-deadline'] as const) {
      memory.liveness.arm({ kind, runId: 'a', delayMs: 60_000 }, () => {});
    }
    memory.liveness.arm({ kind: 'idle-close', runId: 'a', delayMs: 60_000 }, () => {});
    memory.liveness.arm({ kind: 'inbox-claim', runId: 'b', delayMs: 60_000 }, () => {});
    memory.write('a', 'imageSeq', 1);
    memory.release('a');
    expect(memory.holds('a')).toBe(false);
    expect(memory.liveness.armedIn('a', 'run')).toEqual([]);
    expect(memory.liveness.armedIn('a', 'execution')).toEqual(['idle-close']);
    expect(memory.liveness.armedIn('b', 'run')).toEqual(['inbox-claim']);
    memory.liveness.dispose();
  });

  it('keeps an ended run until no run-scope bound is armed, so a pending expiry still runs', () => {
    const memory = new RunMemory();
    memory.write('run', 'imageSeq', 1);
    memory.liveness.arm({ kind: 'subagent-retry', runId: 'run', delayMs: 60_000 }, () => {});
    memory.releaseIfEnded('run', { status: RUN_STATUS.done }, () => false);
    expect(memory.holds('run')).toBe(true);
    expect(memory.liveness.has('subagent-retry', 'run')).toBe(true);
    memory.liveness.clear('subagent-retry', 'run');
    memory.releaseIfEnded('run', { status: RUN_STATUS.done }, () => false);
    expect(memory.holds('run')).toBe(false);
  });
});

describe('runMemoryReleases', () => {
  it.each([
    ['a deleted run', undefined, false, true],
    ['done', { status: RUN_STATUS.done }, false, true],
    ['failed', { status: RUN_STATUS.failed }, false, true],
    ['cancelled', { status: RUN_STATUS.cancelled }, false, true],
    ['review, which takes feedback', { status: RUN_STATUS.review }, false, false],
    ['waiting, also a usage-limit hold', { status: RUN_STATUS.waiting }, false, false],
    ['queued', { status: RUN_STATUS.queued }, false, false],
    ['running', { status: RUN_STATUS.running }, false, false],
    ['failed with an open wait', { status: RUN_STATUS.failed, waits: openWait }, false, false],
    ['done while this manager still holds it', { status: RUN_STATUS.done }, true, false],
  ] as const)('%s', (_label, run, live, releases) => {
    expect(runMemoryReleases(run, live)).toBe(releases);
  });
});
