import { expect } from 'vitest';
import { runnerDefinition } from './runner-registry.ts';
import { driveSeam, waitFor } from './harness-parity-core.testkit.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDeliveryControl, type DeliveryControlOptions } from '../../scripts/mock-delivery-control.mjs';

import { HARNESS_ADAPTERS } from './harness-parity-core.testkit.ts';

/** Run `body` with a Native delivery control set for the fixture: the real native mock
 * reads it (`CEZ_MOCK_DELIVERY_CONTROL`); nothing rewrites mock source. Every
 * environment value this sets is restored afterwards, absence included. */
async function withDeliveryControl<T>(runner: string, options: DeliveryControlOptions,
  body: (control: ReturnType<typeof createDeliveryControl>) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 'cez-delivery-'));
  const adapter = HARNESS_ADAPTERS[runner]!;
  const keys = ['CEZ_MOCK_DELIVERY_CONTROL', 'CEZ_DRY_RUN', adapter.binEnv];
  const saved = keys.map(key => process.env[key]);
  try {
    const control = createDeliveryControl(root, options);
    process.env.CEZ_MOCK_DELIVERY_CONTROL = control.path;
    process.env.CEZ_DRY_RUN = '0';
    process.env[adapter.binEnv]! = adapter.mockBin;
    return await body(control);
  } finally {
    keys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i]; });
    rmSync(root, { recursive: true, force: true });
  }
}

/** Reject exactly one matching input through the real protocol; a reopened
 * process accepts it. No session/manager mock and no transport-error inference.
 * `persistent` rejects every such input, in every process, until `lift()`. */
export function withRejectedInput(runner: string, body: (lift: () => void) => Promise<void>,
  { persistent = false, match = 'reject-owned-turn' } = {}): Promise<void> {
  return withDeliveryControl(runner, { kind: 'reject', match, persistent }, control => body(control.lift));
}

/** Hold only the transport acknowledgement of a matching input; the turn's real frames
 * still reach the runner. On a wire whose prompt response ends the turn
 * (`promptResponseEndsTurn`), the mock holds that response: the turn's first agent work still
 * acknowledges the input, so this holds only the turn end there. */
export function withHeldAck(runner: string, body: (release: () => void, held: () => boolean) => Promise<void>,
  match = 'delay-owned-ack'): Promise<void> {
  return withDeliveryControl(runner, { kind: 'hold-ack', match }, control => body(control.release, control.held));
}

/** Admit a matching input, then send no turn content until release. Claude acknowledges
 * agent input with its local stdin write, so on Claude this is the executable form of the
 * pipe-write exemption: holding the response cannot construct a turn-end-before-ACK race. */
export function withHeldResponse(runner: string, body: (release: () => void, held: () => boolean) => Promise<void>,
  match = 'mock:agent-echo'): Promise<void> {
  return withDeliveryControl(runner, { kind: 'hold-response', match }, control => body(control.release, control.held));
}

/** Hold a matching input's acknowledgement until release. A wire whose turn's first agent work
 * acknowledges a prompt (`promptResponseEndsTurn`) holds the turn's content; every other wire
 * holds the transport acknowledgement alone, and the turn's frames still arrive. */
export function withDelayedAck(runner: string, body: (release: () => void, held: () => boolean) => Promise<void>,
  match = 'delay-owned-ack'): Promise<void> {
  return runnerDefinition(runner).mock.promptResponseEndsTurn ? withHeldResponse(runner, body, match) : withHeldAck(runner, body, match);
}

/** Acknowledge a matching input, then keep its turn open until release. A wire whose turn's
 * first agent work acknowledges a prompt holds the prompt response that ends the turn; every
 * other wire holds the turn's content after its acknowledgement. */
export function withTurnOpenAfterAck(runner: string, body: (release: () => void, held: () => boolean) => Promise<void>,
  match: string): Promise<void> {
  return runnerDefinition(runner).mock.promptResponseEndsTurn ? withHeldAck(runner, body, match) : withHeldResponse(runner, body, match);
}

/** Control for wires whose idle prompt response is the turn-completion frame. Antigravity
 * evidence: __fixtures__/prompt-*.ndjson. The turn's first agent work acknowledges the prompt;
 * the held response holds only the turn end. */
export async function assertPromptResponseCompletion(runner: string): Promise<void> {
  expect(runnerDefinition(runner).mock.promptResponseEndsTurn).toBe(true);
  await withHeldAck(runner, async (release, held) => {
    await driveSeam(runner, 'baseline', { whileOpen: async (session, { v1 }) => {
      await waitFor(() => v1.some(event => event.type === 'turn-end'));
      const ends = v1.filter(event => event.type === 'turn-end').length;
      const response = session.sendAgentMessage([{ type: 'text', text: 'mock:agent-echo delay-owned-ack completion-control' }]);
      expect(response).toBeInstanceOf(Promise);
      if (!response) throw new Error('Completion control was not admitted');
      await response;
      expect(v1.some(event => event.type === 'text' && event.text.includes('completion-control'))).toBe(true);
      await waitFor(held);
      expect(v1.filter(event => event.type === 'turn-end')).toHaveLength(ends);
      release();
      await waitFor(() => v1.filter(event => event.type === 'turn-end').length === ends + 1);
    } });
  });
}
