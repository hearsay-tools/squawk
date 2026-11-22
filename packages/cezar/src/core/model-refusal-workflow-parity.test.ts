import './created-runners.testkit.ts';
import { expect, it } from 'vitest';
import { waitFor } from './harness-parity-core.testkit.ts';
import { driveRun } from './workflow-parity-core.testkit.ts';
import { registerRunner } from './runner-registry.ts';
import { claudeRunner } from '../runners/claude/definition.ts';
registerRunner(claudeRunner);

// The workflow must remain active through the native error turn, rather than
// failing or parking on the intermediate v2 turn.completed(error).
it('Claude retry keeps the workflow step active until the recovered turn ends', async () => {
  let completed = false;
  const observation = await driveRun('claude', { prompt: 'mock:model-refusal:seed' },
    () => completed, 30_000, undefined, {
      during: async ({ store, manager, runId }) => {
        await waitFor(() => store.getRun(runId)?.status === 'waiting');
        expect(manager.sendMessage(runId, [{ type: 'text', text: 'mock:model-refusal:once' }])).toBe(true);
        await waitFor(() => store.eventLog.readEvents(runId).some(e => e.type === 'note' && /retrying/.test(String(e.message))));
        expect(store.getRun(runId)?.status).toBe('running');
        expect(store.getRun(runId)?.steps[0]?.status).toBe('running');
        expect(store.eventLog.readEvents(runId).some(e => e.type === 'error')).toBe(false);
        await waitFor(() => store.getRun(runId)?.status === 'waiting'
          && store.eventLog.readEvents(runId).some(e => e.type === 'text' && e.text === 'Completed mock:model-refusal:once'), 15_000);
        completed = true;
      },
    });
  expect(observation.record?.status).toBe('waiting');
  expect(observation.statuses).not.toContain('failed');
  expect(observation.events.some(e => e.type === 'step-end' && e.status === 'failed')).toBe(false);
}, 45_000);
