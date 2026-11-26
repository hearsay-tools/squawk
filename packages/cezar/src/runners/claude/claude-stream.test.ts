import { describe, expect, it } from 'vitest';
import { claudeFrameDidWork, isParentAssistantFrame } from './claude-stream.ts';

// Constructed frames using CLI 2.1.332's live partial-message envelope and deltas.
const frame = (event: unknown) => ({ type: 'stream_event', parent_tool_use_id: null, event });

describe('Claude partial-message lifecycle predicates', () => {
  it('announces parent streaming but ignores nested output and unknown events', () => {
    expect(isParentAssistantFrame(frame({ type: 'message_start' }))).toBe(true);
    expect(isParentAssistantFrame(frame({ type: 'content_block_start' }))).toBe(true);
    expect(isParentAssistantFrame({ ...frame({ type: 'message_start' }), parent_tool_use_id: 'child' })).toBe(false);
    expect(isParentAssistantFrame(frame({}))).toBe(false);
  });

  it('keeps metadata-only refusals retryable but forbids retry after real streamed work', () => {
    expect(claudeFrameDidWork(frame({ type: 'message_start' }), 'missing')).toBe(false);
    expect(claudeFrameDidWork(frame({ type: 'content_block_start', content_block: { type: 'text', text: '' } }), 'missing')).toBe(false);
    for (const delta of [{ type: 'text_delta', text: 'hello' }, { type: 'thinking_delta', thinking: 'reason' }, { type: 'input_json_delta', partial_json: '{' }]) {
      expect(claudeFrameDidWork(frame({ type: 'content_block_delta', delta }), 'missing')).toBe(true);
    }
    expect(claudeFrameDidWork(frame({ type: 'content_block_start', content_block: { type: 'tool_use' } }), 'missing')).toBe(true);
    expect(claudeFrameDidWork(frame({ type: 'content_block_delta', delta: { type: 'signature_delta', signature: 'x' } }), 'missing')).toBe(false);
  });
});
