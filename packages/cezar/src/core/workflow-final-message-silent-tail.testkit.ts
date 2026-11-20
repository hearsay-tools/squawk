import { BUILT_IN_RUNNER_IDS } from '../runners/ids.ts';
import { describe, expect, it } from 'vitest';
import type { UiEvent } from './ui-events.ts';
import { driveSeam } from './harness-parity-core.testkit.ts';

// The silent-tail seam cells: the adapter tier only, apart from the no-wait nudge's engine cells.
function lastTopLevelTail(events: readonly UiEvent[]): Extract<UiEvent, { type: 'item.completed' }>['item'] | undefined {
  const completed = events.filter((e): e is Extract<UiEvent, { type: 'item.completed' }> =>
    e.type === 'item.completed' && e.item.parentItemId === undefined &&
    (e.item.kind === 'message' || e.item.kind === 'reasoning' || e.item.kind === 'tool'));
  return completed.at(-1)?.item;
}

export function describeSilentTail(registration = { describe, it }) {
  const { describe, it } = registration;
describe('silent-tail seam — mapper emits reasoning/tool with no later message (#544)', () => {
  for (const backend of BUILT_IN_RUNNER_IDS) {
    it(`${backend} silent-tail ends on reasoning or tool, not a later assistant message`, async () => {
      const observed = await driveSeam(backend, 'silent-tail');
      const completed = observed.v2.filter((e): e is Extract<UiEvent, { type: 'item.completed' }> =>
        e.type === 'item.completed' && e.item.parentItemId === undefined);
      expect(completed.some(e => e.item.kind === 'message' && e.item.role === 'assistant' && e.item.text.includes('Filing the issue now.'))).toBe(true);
      expect(completed.some(e => e.item.kind === 'reasoning' || e.item.kind === 'tool')).toBe(true);
      const tail = lastTopLevelTail(observed.v2);
      expect(tail?.kind === 'reasoning' || tail?.kind === 'tool').toBe(true);
      if (tail?.kind === 'reasoning') expect(tail.text).toContain('cezar_done');
    });
  }
});
}
