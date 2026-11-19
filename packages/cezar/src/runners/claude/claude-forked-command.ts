/**
 * Typed forked commands (hearsay-tools/squawk#1315). A typed `/name` command whose skill has
 * `context: fork` runs a subagent with no spawn call: its `task_started` carries no tool_use_id
 * and arrives before `init`, and its children name a synthetic parent, `forked-command-<name>`.
 * The first child mints one root task item for the fork, so the fork's work nests under it in
 * the same turn. The item stays running until the turn ends: Claude reports the task completed
 * before its children run.
 */

import type { UiEvent, UiToolItem } from '../../core/ui-events.ts';

const FORKED_COMMAND_PREFIX = 'forked-command-';

interface ForkedCommandStart {
  readonly description?: string | undefined;
  readonly subagentType?: string | undefined;
}

/** The slice of the Claude mapper state that tracks typed forked commands. */
export interface ForkedCommandState {
  /** Claude's task id → the `task_started` of a typed forked command. Its children name the
   *  task in `agent_id`. Cleared when the turn ends. */
  readonly forkedCommandStarts: ReadonlyMap<string, ForkedCommandStart>;
  /** Typed forked commands open in this turn, keyed by the wire parent id their children carry. */
  readonly openForkedCommands: ReadonlyMap<string, UiToolItem>;
  /** Every fork item id minted in this session: a command typed again gets a fresh item id, so
   *  each fork nests in its own turn and never overwrites another fork's item. */
  readonly forkedCommandIds: ReadonlySet<string>;
}

export function withForkedCommandStart<S extends ForkedCommandState>(msg: Record<string, unknown>, state: S): S {
  const taskId = str(msg.task_id);
  if (taskId === undefined) return state;
  const start: ForkedCommandStart = { description: str(msg.description), subagentType: str(msg.subagent_type) };
  return { ...state, forkedCommandStarts: new Map(state.forkedCommandStarts).set(taskId, start) };
}

/** The fork item's start, and the message re-parented under its item id, for a forked command's
 *  child; undefined for any other message. */
export function adoptForkedCommand<S extends ForkedCommandState>(
  msg: Record<string, unknown>,
  state: S,
): { events: UiEvent[]; state: S; msg: Record<string, unknown> } | undefined {
  const wireId = str(msg.parent_tool_use_id);
  if (wireId === undefined || !wireId.startsWith(FORKED_COMMAND_PREFIX)) return undefined;
  const open = state.openForkedCommands.get(wireId);
  if (open) return { events: [], state, msg: { ...msg, parent_tool_use_id: open.id } };
  const item = startForkedCommandItem(wireId, state, str(msg.agent_id));
  const next: S = {
    ...state,
    openForkedCommands: new Map(state.openForkedCommands).set(wireId, item),
    forkedCommandIds: new Set(state.forkedCommandIds).add(item.id),
  };
  return { events: [{ type: 'item.started', item }], state: next, msg: { ...msg, parent_tool_use_id: item.id } };
}

/** The wire id, or the first free `<wire id>-<n>`: a suffixed id can equal another command's
 *  wire id (`/review` typed twice, then `/review-2`), so every minted id is checked. */
function freeForkItemId(wireId: string, minted: ReadonlySet<string>): string {
  let id = wireId;
  for (let n = 2; minted.has(id); n += 1) id = `${wireId}-${n}`;
  return id;
}

function startForkedCommandItem(wireId: string, state: ForkedCommandState, taskId: string | undefined): UiToolItem {
  const start = taskId === undefined ? undefined : state.forkedCommandStarts.get(taskId);
  const item: UiToolItem = {
    kind: 'tool',
    id: freeForkItemId(wireId, state.forkedCommandIds),
    name: 'Skill',
    toolKind: 'task',
    title: start?.description ?? `/${wireId.slice(FORKED_COMMAND_PREFIX.length)}`,
    status: 'running',
  };
  if (start?.subagentType !== undefined) item.input = { subagent_type: start.subagentType };
  return item;
}

/** The turn's end settles every fork it opened: failed when the turn did not end normally
 *  (an error or the turn cap), else completed. */
export function completeForkedCommands(state: ForkedCommandState, turnFailed: boolean): UiEvent[] {
  const status = turnFailed ? 'failed' : 'completed';
  return [...state.openForkedCommands.values()].map((open) => ({ type: 'item.completed', item: { ...open, status } }));
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}
