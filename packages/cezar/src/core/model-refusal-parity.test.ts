import { BUILT_IN_RUNNER_IDS } from '../runners/ids.ts';
import { describe, expect, it } from 'vitest';
import { driveSeam, MODEL_REFUSAL_CRITERIA, promptFor, waitFor } from './harness-parity.testkit.ts';

// Use each runner's native rejection. Claude alone has the selected-model +
// zero-usage result that this change classifies; other wires keep their existing
// rejection policy. None may swallow the error because an earlier turn worked.
describe('post-success provider refusal parity (hearsay-tools/cezarion#1351)', () => {
  for (const backend of BUILT_IN_RUNNER_IDS) {
    const criterion = MODEL_REFUSAL_CRITERIA[0];
    it(`${backend} ${criterion.id} ${criterion.name}`, async () => {
      const observed = await driveSeam(backend, criterion.scenario, {
        timeoutMs: 45_000,
        spec: { userPrompt: backend === 'claude' ? 'mock:model-refusal:seed' : promptFor(backend, 'baseline') },
        whileOpen: async (session, { v1 }) => {
          await waitFor(() => v1.some(e => e.type === 'turn-end'));
          expect(v1.some(e => e.type === 'error')).toBe(false);
          expect(session.sendMessage([{ type: 'text', text: promptFor(backend, criterion.scenario) }])).toBe(true);
          await waitFor(() => v1.some(e => e.type === 'error'), 40_000);
        },
      });
      expect(observed.v1.some(e => e.type === 'error' && e.message.trim() !== '')).toBe(true);
      if (backend === 'claude') {
        expect(observed.v1.filter(e => e.type === 'note' && /retrying.*\/2/.test(e.message))).toHaveLength(2);
        expect(observed.v1.filter(e => e.type === 'turn-end')).toHaveLength(2);
        expect(observed.v1.filter(e => e.type === 'error')).toEqual([{
          type: 'error', message: "There's an issue with the selected model (claude-test-model). It may not exist or you may not have access to it. Run --model to pick a different model.",
        }]);
        expect(observed.v2.filter(e => e.type === 'turn.started')).toHaveLength(4);
        expect(observed.v2.filter(e => e.type === 'turn.completed')).toHaveLength(4);
      }
    }, 60_000);
  }
});
