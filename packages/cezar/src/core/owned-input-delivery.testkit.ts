import { expect } from 'vitest';
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
 * still reach the runner. */
export function withHeldAck(runner: string, body: (release: () => void) => Promise<void>,
  match = 'delay-owned-ack'): Promise<void> {
  return withDeliveryControl(runner, { kind: 'hold-ack', match }, control => body(control.release));
}

/** Admit a matching input, then send no turn content until release. Claude acknowledges
 * agent input with its local stdin write, so on Claude this is the executable form of the
 * pipe-write exemption: holding the response cannot construct a turn-end-before-ACK race. */
export function withHeldResponse(runner: string, body: (release: () => void, held: () => boolean) => Promise<void>,
  match = 'mock:agent-echo'): Promise<void> {
  return withDeliveryControl(runner, { kind: 'hold-response', match }, control => body(control.release, control.held));
}

/** Inverse control for wires whose idle prompt response is the turn-completion frame.
 * Antigravity evidence: __fixtures__/prompt-*.ndjson. The mock holds only that response. */
export async function assertPromptResponseCompletion(runner: string): Promise<void> {
  await withHeldAck(runner, async release => {
    await driveSeam(runner, 'baseline', { whileOpen: async (session, { v1 }) => {
      await waitFor(() => v1.some(event => event.type === 'turn-end'));
      const ends = v1.filter(event => event.type === 'turn-end').length;
      const response = session.sendAgentMessage([{ type: 'text', text: 'mock:agent-echo delay-owned-ack completion-control' }]);
      expect(response).toBeInstanceOf(Promise);
      if (!response) throw new Error('Completion control was not admitted');
      let acknowledged = false;
      void response.then(() => { acknowledged = true; }, () => {});
      await waitFor(() => v1.some(event => event.type === 'text' && event.text.includes('completion-control')));
      expect(acknowledged).toBe(false);
      expect(v1.filter(event => event.type === 'turn-end')).toHaveLength(ends);
      release(); await response;
      expect(acknowledged).toBe(true);
      expect(v1.filter(event => event.type === 'turn-end')).toHaveLength(ends + 1);
    } });
  });
}
