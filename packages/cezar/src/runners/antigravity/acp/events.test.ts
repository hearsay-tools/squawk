import { expect, it } from 'vitest';
import type { UiEvent } from '../../../core/ui-events.ts';
import { AcpEvents } from './events.ts';

it('ignores native command catalogs on new sessions and resumes', () => {
  const ui: UiEvent[] = [];
  const events = new AcpEvents({ uiEvent: event => ui.push(event) }, {});
  events.update({ sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'help', description: 'Help' }] });
  expect(ui).toEqual([]);
});

it.each(['end_turn', 'cancelled'] as const)('fails open tools before the %s turn boundary', reason => {
  const ui: UiEvent[] = [];
  const events = new AcpEvents({ uiEvent: event => ui.push(event) }, {});
  events.begin();
  events.update({ sessionUpdate: 'tool_call', toolCallId: 'open', title: 'run_command', kind: 'execute', status: 'in_progress' });
  events.update({ sessionUpdate: 'tool_call', toolCallId: 'finished', title: 'view_file', status: 'completed' });
  events.finish(reason);
  const completed = ui.filter(event => event.type === 'item.completed');
  expect(completed).toHaveLength(2);
  // oxlint-disable-next-line cez/test-enum-literal -- UI tool status is independent of run status.
  expect(completed).toContainEqual(expect.objectContaining({ item: expect.objectContaining({ id: 'open', status: 'failed', output: expect.stringContaining(reason === 'cancelled' ? 'Cancelled' : 'Turn ended') }) }));
  expect(ui.at(-1)).toMatchObject({ type: 'turn.completed', stopReason: reason });
});

const hooks = { agentWorkEnds: (update: Record<string, unknown>, previous: string | undefined) => update.sessionUpdate === 'usage_update' && previous === 'agent_message_chunk' };

it('opens an agent-started turn for work with no prompt and ends it after the closing usage update', () => {
  const ui: UiEvent[] = [];
  const events = new AcpEvents({ uiEvent: event => ui.push(event) }, hooks);
  events.update({ sessionUpdate: 'usage_update', used: 1, size: 10 });
  expect(events.turnOpen).toBe(false);
  events.update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'woke' } });
  expect(events.agentTurn).toBe(true);
  events.update({ sessionUpdate: 'usage_update', used: 2, size: 10 });
  expect(events.turnOpen).toBe(true);
  events.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } });
  events.update({ sessionUpdate: 'usage_update', used: 3, size: 10 });
  expect(events.turnOpen).toBe(false);
  expect(ui.map(event => event.type).filter(type => type.startsWith('turn.'))).toEqual(['turn.started', 'turn.completed']);
});

it('keeps a call open across a normal turn end and closes it once when it completes later', () => {
  const ui: UiEvent[] = [];
  const events = new AcpEvents({ uiEvent: event => ui.push(event) }, hooks);
  events.begin();
  events.update({ sessionUpdate: 'tool_call', toolCallId: 'bg', title: 'sleep 9', kind: 'execute', status: 'in_progress' });
  events.finish('end_turn');
  expect(ui.filter(event => event.type === 'item.completed')).toEqual([]);
  events.update({ sessionUpdate: 'tool_call_update', toolCallId: 'bg', status: 'completed' });
  events.update({ sessionUpdate: 'tool_call_update', toolCallId: 'bg', status: 'completed' });
  expect(ui.filter(event => event.type === 'item.completed')).toHaveLength(1);
  expect(events.agentTurn).toBe(true);
});

it('ignores a late update for a call the cancelled turn already closed', () => {
  const ui: UiEvent[] = [];
  const events = new AcpEvents({ uiEvent: event => ui.push(event) }, hooks);
  events.begin();
  events.update({ sessionUpdate: 'tool_call', toolCallId: 'fg', title: 'sleep 30', kind: 'execute', status: 'in_progress' });
  events.finish('cancelled');
  // oxlint-disable-next-line cez/test-enum-literal -- ACP tool status has its own vocabulary.
  events.update({ sessionUpdate: 'tool_call_update', toolCallId: 'fg', status: 'failed' });
  expect(events.turnOpen).toBe(false);
  expect(ui.filter(event => event.type === 'item.completed')).toHaveLength(1);
});

it('ends the turn as failed when the executor error is its whole last message, and lets a prompt adopt an agent-started turn', () => {
  const ui: UiEvent[] = [];
  const errors: string[] = [];
  const events = new AcpEvents({ uiEvent: event => ui.push(event), event: event => { if (event.type === 'error') errors.push(event.message); } }, { ...hooks,
    updateError: update => update.sessionUpdate === 'agent_message_chunk' && JSON.stringify(update).includes('⚠') ? 'failed' : undefined });
  events.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'working' } });
  events.adopt();
  expect(events.agentTurn).toBe(false);
  events.update({ sessionUpdate: 'tool_call', toolCallId: 'read', title: 'File a.txt', kind: 'read', status: 'completed' });
  events.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '⚠ agent executor error: 400' } });
  events.update({ sessionUpdate: 'usage_update', used: 3, size: 10 });
  expect(events.turnOpen).toBe(true);
  events.finish('end_turn');
  expect(ui.at(-1)).toMatchObject({ type: 'turn.completed', stopReason: 'error' });
  expect(errors).toEqual(['failed']);
});

it.each([
  ['inside a longer message', [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Result: ' } }, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '⚠ careful' } }]],
  ['followed by more work', [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '⚠ careful' } }, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'next' } }]],
])('keeps error-shaped text %s as text', (_case, updates) => {
  const ui: UiEvent[] = [];
  const events = new AcpEvents({ uiEvent: event => ui.push(event) }, { ...hooks,
    updateError: update => update.sessionUpdate === 'agent_message_chunk' && JSON.stringify(update).includes('⚠') ? 'failed' : undefined });
  events.begin();
  for (const update of updates) events.update(update);
  events.finish('end_turn');
  expect(ui.at(-1)).toMatchObject({ type: 'turn.completed', stopReason: 'end_turn' });
});

const texts = (events: AcpEvents, chunks: string[]): void => {
  for (const text of chunks) events.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
};

function v1Texts(): { events: AcpEvents; v1: string[]; order: string[] } {
  const v1: string[] = [];
  const order: string[] = [];
  const events = new AcpEvents({
    event: event => { if (event.type === 'text') { v1.push(event.text); order.push(`text:${event.text}`); } },
    uiEvent: event => { if (event.type === 'item.started' || event.type === 'item.completed') order.push(`${event.type}:${event.item.id}`); },
  }, {});
  events.begin();
  return { events, v1, order };
}

it('holds message chunks as one v1 text and emits it after the v2 item completes', () => {
  const { events, v1, order } = v1Texts();
  texts(events, ['Opened the PR.\n\nCEZ:PR=4', '104\n\n- done', '.\n']);
  expect(v1).toEqual([]);
  events.finish('end_turn');
  expect(v1).toEqual(['Opened the PR.\n\nCEZ:PR=4104\n\n- done.\n']);
  expect(order.slice(-2)).toEqual([expect.stringMatching(/^item\.completed:/), 'text:Opened the PR.\n\nCEZ:PR=4104\n\n- done.\n']);
});

it('keeps a marker split across chunks whole in one v1 text', () => {
  const { events, v1 } = v1Texts();
  texts(events, ['All done. C', 'E', 'Z:DONE']);
  events.finish('end_turn');
  expect(v1).toEqual(['All done. CEZ:DONE']);
});

it('releases held text on a usage update without closing the item, and never re-emits it', () => {
  const { events, v1, order } = v1Texts();
  texts(events, ['Working']);
  events.update({ sessionUpdate: 'usage_update', used: 1, size: 10 });
  expect(v1).toEqual(['Working']);
  expect(order.filter(entry => entry.startsWith('item.completed'))).toEqual([]);
  texts(events, [' on it.']);
  events.update({ sessionUpdate: 'usage_update', used: 2, size: 10 });
  events.finish('end_turn');
  expect(v1).toEqual(['Working', ' on it.']);
  const items = order.filter(entry => entry.startsWith('item.'));
  expect(items).toEqual([items[0], items[0]!.replace('started', 'completed')]);
});

it('emits held text and the completed item once when a text listener flushes again', () => {
  const v1: string[] = [];
  const completed: UiEvent[] = [];
  const events: AcpEvents = new AcpEvents({
    event: event => { if (event.type === 'text') { v1.push(event.text); events.flush(); } },
    uiEvent: event => { if (event.type === 'item.completed') completed.push(event); },
  }, hooks);
  events.begin();
  texts(events, ['Done. CEZ:D']);
  events.flush();
  expect(v1).toEqual(['Done. CEZ:D']);
  expect(completed).toHaveLength(1);
});
