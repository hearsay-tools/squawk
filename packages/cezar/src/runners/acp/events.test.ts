import { expect, it } from 'vitest';
import type { UiEvent } from '../../core/ui-events.ts';
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
