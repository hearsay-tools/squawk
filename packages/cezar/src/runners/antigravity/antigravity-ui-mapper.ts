import { z } from 'zod';
import type { UiEvent } from '../../core/ui-events.ts';
import { AcpEvents } from '../acp/events.ts';
import { antigravityTool } from './tool-normalization.ts';
import { antigravityUsage } from './usage.ts';
import { filterAntigravityUpdate, antigravityUpdateError } from './wire-updates.ts';

export interface AntigravityUiState { events: AcpEvents; prompts: Array<string | number>; error?: string | undefined }
export function createAntigravityUiState(): AntigravityUiState {
  return { events: new AcpEvents({}, { normalizeTool: antigravityTool }), prompts: [] };
}
const envelopeSchema = z.object({ from: z.enum(['client', 'agent']), frame: z.record(z.string(), z.unknown()) });
const resultSchema = z.object({ stopReason: z.enum(['end_turn', 'max_tokens', 'max_turn_requests', 'cancelled', 'refusal']) }).passthrough();
/** Fixture envelopes retain both directions, including early steering acknowledgements. */
export function mapAntigravityFrame(value: unknown, state: AntigravityUiState): { state: AntigravityUiState; events: UiEvent[] } {
  const envelope = envelopeSchema.safeParse(value);
  if (!envelope.success) return { state, events: [] };
  const events: UiEvent[] = [];
  const next: AntigravityUiState = { ...state, prompts: [...state.prompts], events: state.events.fork({ uiEvent: event => events.push(event) }) };
  const { frame, from } = envelope.data;
  try {
    if (from === 'client' && frame.method === 'session/prompt') {
      const id = z.union([z.string(), z.number()]).parse(frame.id);
      if (!next.prompts.length) next.events.begin();
      next.prompts.push(id);
    }
    if (from === 'agent' && frame.method === 'session/update') {
      const params = z.object({ update: z.record(z.string(), z.unknown()) }).parse(frame.params);
      next.error = antigravityUpdateError(params.update) ?? next.error;
      if (filterAntigravityUpdate(params.update)) next.events.update(params.update);
    }
    if (from === 'agent' && frame.id !== undefined) finishResponse(frame, next);
  } catch { /* Malformed frames do not poison the next valid frame. */ }
  return { state: next, events };
}

function finishResponse(frame: Record<string, unknown>, state: AntigravityUiState): void {
  const index = state.prompts.findIndex(id => id === frame.id);
  if (index < 0) return;
  const result = resultSchema.safeParse(frame.result);
  if (!result.success && !frame.error) return;
  state.prompts.splice(index, 1);
  if (index !== 0) return;
  const reason = result.success ? result.data.stopReason : 'error';
  state.events.finish(state.error ? 'error' : reason === 'max_turn_requests' ? 'max_tokens' : reason,
    result.success ? antigravityUsage(result.data.usage) : undefined);
  delete state.error;
  if (state.prompts.length) state.events.begin();
}
