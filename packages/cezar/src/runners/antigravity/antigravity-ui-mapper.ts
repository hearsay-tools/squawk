import { z } from 'zod';
import type { UiEvent } from '../../core/ui-events.ts';
import { AcpEvents } from '../acp/events.ts';
import { antigravityTool } from './tool-normalization.ts';
import { antigravityUsage } from './usage.ts';

export interface AntigravityUiState { events: AcpEvents; promptId?: string | number }
export function createAntigravityUiState(): AntigravityUiState {
  return { events: new AcpEvents({}, { normalizeTool: antigravityTool }) };
}
const envelopeSchema = z.object({ from: z.enum(['client', 'agent']), frame: z.record(z.string(), z.unknown()) });
/** Fixture envelopes keep both directions, so prompt boundaries can be replayed exactly. */
export function mapAntigravityFrame(value: unknown, state: AntigravityUiState): { state: AntigravityUiState; events: UiEvent[] } {
  const envelope = envelopeSchema.safeParse(value);
  if (!envelope.success) return { state, events: [] };
  const events: UiEvent[] = [];
  const next: AntigravityUiState = { ...state, events: state.events.fork({ uiEvent: event => events.push(event) }) };
  const { frame, from } = envelope.data;
  try {
    if (from === 'client' && frame.method === 'session/prompt' && next.promptId === undefined) {
      next.promptId = z.union([z.string(), z.number()]).parse(frame.id); next.events.begin();
    }
    if (from === 'agent' && frame.method === 'session/update') {
      const params = z.object({ update: z.record(z.string(), z.unknown()) }).parse(frame.params);
      next.events.update(params.update);
    }
    if (from === 'agent' && frame.id === next.promptId && next.promptId !== undefined) {
      const result = z.object({ stopReason: z.enum(['end_turn', 'max_tokens', 'cancelled', 'refusal']) }).passthrough().parse(frame.result);
      next.events.finish(result.stopReason, antigravityUsage(result.usage)); delete next.promptId;
    }
  } catch { /* A malformed frame never poisons the next valid frame. */ }
  return { state: next, events };
}
