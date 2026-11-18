import type { UiToolItem } from '../../core/ui-events.ts';

/** At most this many names of each kind reach the resume message. */
const MAX_NAMES = 5;
/** A name longer than this is cut, so one long command line cannot fill the prompt. */
const MAX_NAME_LENGTH = 120;

export interface CutOffWork { tools?: string[] | undefined; subagents?: string[] | undefined }

const shorten = (text: string): string => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > MAX_NAME_LENGTH ? `${line.slice(0, MAX_NAME_LENGTH - 1)}…` : line;
};

const open = (item: UiToolItem): boolean => item.status === 'running' || item.status === 'pending';

type Snapshot = { item: UiToolItem; stepId: string | undefined };

/** The open root items a restart cut off: the last turn's calls, and background subagents. */
function openItems(events: Iterable<unknown>): { tools: Snapshot[]; subagents: Snapshot[] } {
  const turnItems = new Map<string, Snapshot>();
  const background = new Map<string, Snapshot>();
  for (const event of events) {
    const record = event as { type?: unknown; item?: unknown; stepId?: unknown };
    if (record.type === 'turn.started') { turnItems.clear(); continue; }
    const item = record.item as UiToolItem | undefined;
    if (item?.kind !== 'tool' || item.parentItemId !== undefined) continue;
    const snapshot = { item, stepId: typeof record.stepId === 'string' ? record.stepId : undefined };
    // A spawn turns background in a later snapshot of the same item.
    if (item.background === true || background.has(item.id)) { background.set(item.id, snapshot); turnItems.delete(item.id); }
    else turnItems.set(item.id, snapshot);
  }
  const live = (map: Map<string, Snapshot>) => [...map.values()].filter(({ item }) => open(item));
  return { tools: live(turnItems), subagents: live(background) };
}

const nameOf = ({ item }: Snapshot) => shorten(item.title && item.title !== item.name ? `${item.name}: ${item.title}` : item.name);
const capped = (names: string[]) => names.length > MAX_NAMES ? [...names.slice(0, MAX_NAMES), `${names.length - MAX_NAMES} more`] : names;

function namesOf({ tools, subagents }: { tools: Snapshot[]; subagents: Snapshot[] }): CutOffWork | undefined {
  if (!tools.length && !subagents.length) return undefined;
  return { ...(tools.length ? { tools: capped(tools.map(nameOf)) } : {}), ...(subagents.length ? { subagents: capped(subagents.map(nameOf)) } : {}) };
}

/**
 * The work a restart cut off, read from the run's own event log (hearsay-tools/squawk#3909): the
 * root tool calls of the last turn that have no result, and the native subagents still running.
 * A subagent may have started in an earlier turn, so those come from the whole log. Each name is
 * the tool name and its title. Squawk records these items for every runner, so no runner's own
 * transcript is read. Undefined when nothing was cut off.
 */
export function cutOffWork(events: Iterable<unknown>): CutOffWork | undefined {
  return namesOf(openItems(events));
}

/** The event log a restart reads and closes the cut-off items in. */
export interface CutOffLog {
  readEvents(runId: string): Iterable<unknown>;
  appendEvent(runId: string, event: { type: string; stepId?: string | undefined; [key: string]: unknown }): unknown;
}

/**
 * Names the work a restart cut off, then ends each of those items as `declined`: their process is
 * gone, so the activity view stops showing them running and a later restart does not name them
 * again. A log that cannot be read or written names what it found and closes what it can.
 */
export function recordCutOffWork(log: CutOffLog, runId: string): CutOffWork | undefined {
  let found: { tools: Snapshot[]; subagents: Snapshot[] };
  try { found = openItems(log.readEvents(runId)); } catch { return undefined; }
  for (const { item, stepId } of [...found.tools, ...found.subagents]) {
    try { log.appendEvent(runId, { type: 'item.completed', ...(stepId ? { stepId } : {}), item: { ...item, status: 'declined' } }); }
    catch { /* the names still reach the resume */ }
  }
  return namesOf(found);
}

/** The resume sentences for `work`, or undefined. */
export function cutOffSentence(work: CutOffWork | undefined): string | undefined {
  if (!work) return undefined;
  const parts: string[] = [];
  if (work.tools?.length) parts.push(`The restart cut off these tool calls, which have no result: ${work.tools.join('; ')}.`);
  if (work.subagents?.length) parts.push(`These native subagents were still running and stopped: ${work.subagents.join('; ')}. Their partial work is lost; start them again if you still need it.`);
  return parts.join(' ');
}

/**
 * A restart's resume context with the work this restart cut off. Every restart scans, since a
 * resumed turn can start new work and crash again before its checkpoint clears; found work replaces
 * the earlier names. A scan that finds nothing (closed already, as on the second call within one
 * restart) keeps them.
 */
export function withCutOff<T extends { restarted?: true | undefined; cutOff?: CutOffWork | undefined }>(log: CutOffLog, runId: string, context: T): T {
  if (!context.restarted) return context;
  const cutOff = recordCutOffWork(log, runId);
  return cutOff ? { ...context, cutOff } : context;
}
