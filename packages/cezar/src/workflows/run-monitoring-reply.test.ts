import '../runners/claude/claude-runner.testkit.ts';
import { setupMonitoringFixture } from './run-fixture.testkit.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WAIT_KIND, WAIT_VIA } from '@open-mercato/cezar-contract/test-factories.testkit';
import { deriveAttention } from '@open-mercato/cezar-contract/attention';
describe('RunManager monitoring reply', () => {
  const fixture = setupMonitoringFixture();
  const { SINGLE_STEP, waitFor, openTimer } = fixture;
  it('a user reply to a monitoring run keeps its timer (hearsay-tools/cezarion#1233)', async () => {
    const idle = fixture.observeIdleTimers();
    const wakes = fixture.observeWakeTimers();
    const record = fixture.manager.startRun(SINGLE_STEP, { task: 'mock:cezar-wait keep going', worktree: false });
    fixture.currentId = record.id;
    await waitFor(record.id, (r) => r?.status === 'waiting' && Boolean(openTimer(r)));
    const timer = openTimer(fixture.store.getRun(record.id))!;
    expect(timer).toMatchObject({ kind: WAIT_KIND.timer, via: WAIT_VIA.cezar_wait });
    expect(deriveAttention(fixture.store.getRun(record.id)!).label).toBe('monitoring');
    // A user reply (no marker) resumes the run; the follow-up turn re-parks on the same timer.
    const boundaries = () => readFileSync(join(fixture.repoRoot, '.ai/cezar/runs', `${record.id}.ndjson`), 'utf8').split('"type":"turn-end"').length;
    const before = boundaries();
    expect(fixture.manager.sendMessage(record.id, [{ type: 'text', text: 'thanks, carry on' }])).toBe(true);
    await waitFor(record.id, (r) => r?.status === 'waiting' && boundaries() > before);
    expect(openTimer(fixture.store.getRun(record.id))?.id).toBe(timer.id);
    expect(deriveAttention(fixture.store.getRun(record.id)!).label).toBe('monitoring');
    expect(wakes.captured).toBe(1);
    wakes.fire(0);
    await waitFor(record.id, run => run?.lastWaits?.some(wait => wait.id === timer.id && wait.phase === 'delivered') === true);
    expect(fixture.store.getRun(record.id)?.agentInputs?.filter(input => input.id === timer.id)).toHaveLength(1);
    expect(idle.pending).toBe(0); // durable monitors have no user-wait idle timer
  }, 30_000);
});
