import { z } from 'zod';
import type { TokenUsage, UiEvent } from '@hearsay-tools/squawk/plugin';
import { AcpEvents } from './acp/events.ts';
import { addUsage } from './acp/usage.ts';
import { antigravityUsage } from './usage.ts';
import { ANTIGRAVITY_WIRE_HOOKS } from './wire-updates.ts';

export interface AntigravityUiState {
  events: AcpEvents; prompts: Array<string | number>; promptUsage?: TokenUsage | undefined;
  /** A session/load request whose history replay is not live work. */
  loading?: string | number | undefined;
}
export function createAntigravityUiState(): AntigravityUiState {
  return { events: new AcpEvents({}, ANTIGRAVITY_WIRE_HOOKS), prompts: [] };
}
const envelopeSchema = z.object({ from: z.enum(['client', 'agent']), frame: z.record(z.string(), z.unknown()) });
const resultSchema = z.object({ stopReason: z.enum(['end_turn', 'max_tokens', 'max_turn_requests', 'cancelled', 'refusal']) }).passthrough();
/** Fixture envelopes retain both directions, as AcpSession sees them. */
export function mapAntigravityFrame(value: unknown, state: AntigravityUiState): { state: AntigravityUiState; events: UiEvent[] } {
  const envelope = envelopeSchema.safeParse(value);
  if (!envelope.success) return { state, events: [] };
  const events: UiEvent[] = [];
  const next: AntigravityUiState = { ...state, prompts: [...state.prompts], events: state.events.fork({ uiEvent: event => events.push(event) }) };
  const { frame, from } = envelope.data;
  try {
    if (from === 'client' && frame.method === 'session/prompt') {
      const id = z.union([z.string(), z.number()]).parse(frame.id);
      if (!next.prompts.length) beginPrompt(next);
      next.prompts.push(id);
    }
    if (from === 'client' && frame.method === 'session/load') next.loading = z.union([z.string(), z.number()]).parse(frame.id);
    if (from === 'agent' && frame.id !== undefined && frame.id === next.loading && frame.method === undefined) delete next.loading;
    if (from === 'agent' && frame.method === 'session/update' && next.loading === undefined) {
      const params = z.object({ update: z.record(z.string(), z.unknown()) }).parse(frame.params);
      next.events.update(params.update);
    }
    if (from === 'agent' && frame.id !== undefined) finishResponse(frame, next);
  } catch { /* Malformed frames do not poison the next valid frame. */ }
  return { state: next, events };
}

function beginPrompt(state: AntigravityUiState): void {
  delete state.promptUsage;
  if (state.events.agentTurn) state.events.adopt();
  else state.events.begin();
}

function finishResponse(frame: Record<string, unknown>, state: AntigravityUiState): void {
  const index = state.prompts.findIndex(id => id === frame.id);
  if (index < 0) return;
  const result = resultSchema.safeParse(frame.result);
  if (!result.success && !frame.error) return;
  state.prompts.splice(index, 1);
  const usage = result.success ? antigravityUsage(result.data.usage) : undefined;
  if (usage) state.promptUsage = addUsage(state.promptUsage, usage);
  if (index !== 0) return;
  const reason = result.success ? result.data.stopReason : 'error';
  // The steered prompt still pending carries the turn: the agent ended this prompt to read it.
  if (state.prompts.length && reason === 'end_turn') return;
  state.events.finish(reason === 'max_turn_requests' ? 'max_tokens' : reason, state.promptUsage);
  delete state.promptUsage;
  if (state.prompts.length) beginPrompt(state);
}

