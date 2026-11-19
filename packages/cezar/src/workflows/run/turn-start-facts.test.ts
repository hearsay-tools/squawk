import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RUNNER_IDS, type RunnerId } from '../../core/agent-runner.ts';
import { RUNNER_FACTS } from '../../core/runner-facts.ts';
import { MAX_AUTO_CONTINUES } from '../run.ts';
import { boundaryInputFixture } from './boundary-input-order.testkit.ts';
import { transitionTurnBoundary } from './turn-boundary.ts';

// Swap the declarations of claude and codex, so the test proves the answer's flush does not read
// the declared `turnStart` or the runner id (hearsay-tools/squawk#2702).
vi.mock('../../core/runner-facts.ts', async (load) => {
  const actual = await load<typeof import('../../core/runner-facts.ts')>();
  // The spread below reads every runner's facts from the registry.
  await import('../../core/register-all-runners.testkit.ts');
  return { ...actual, RUNNER_FACTS: {
    ...actual.RUNNER_FACTS,
    claude: { ...actual.RUNNER_FACTS.claude, turnStart: 'on-wire' },
    codex: { ...actual.RUNNER_FACTS.codex, turnStart: 'on-write' },
  } };
});

afterEach(() => vi.restoreAllMocks());

/** A live answer to a question parked at its turn boundary, on a wire that reports the answer's
 *  turn as `runner` declares. Returns what the answer's flush received. */
function answerAtCap(runner: RunnerId) {
  const f = boundaryInputFixture();
  vi.mocked(f.wire.sendMessage).mockImplementation(() => {
    if (RUNNER_FACTS[runner].turnStart === 'on-write') transitionTurnBoundary(f.state, { kind: 'turn-started', phase: 'clear-boundary', session: f.wire });
    return true;
  });
  transitionTurnBoundary(f.state, { kind: 'turn-end', phase: 'ui-completed', session: f.wire });
  f.store.appendEvent(f.run.id, { type: 'ask.requested', requestId: randomUUID(), questions: [{ header: 'Choice', question: 'Next?' }] });
  f.store.updateRun(f.run.id, { automaticWakes: MAX_AUTO_CONTINUES });
  expect(f.delivery.sendMessage(f.run.id, [{ type: 'text', text: 'Answer' }])).toBe(true);
  return vi.mocked(f.delivery.flushAgentInputs).mock.calls;
}

describe('the answer flush follows no declared turn start', () => {
  it('reads the swapped declarations', () => {
    expect(RUNNER_IDS.filter(id => RUNNER_FACTS[id].turnStart === 'on-write')).toEqual(['codex', 'pi', 'omp']);
  });

  it.each(RUNNER_IDS)('%s: the flush decides the cap at the boundary before the answer was written', runner => {
    expect(answerAtCap(runner)).toEqual([[expect.any(String), { spent: MAX_AUTO_CONTINUES, atTurnBoundary: true }]]);
  });
});
