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

/**
 * The work a restart cut off, read from the run's own event log (hearsay-tools/squawk#3909): the
 * root tool calls of the last turn that have no result, and the native subagents still running.
 * A subagent may have started in an earlier turn, so those come from the whole log. Each name is
 * the tool name and its title. Squawk records these items for every runner, so no runner's own
 * transcript is read. Undefined when nothing was cut off.
 */
export function cutOffWork(events: Iterable<unknown>): CutOffWork | undefined {
  const turnItems = new Map<string, UiToolItem>();
  const background = new Map<string, UiToolItem>();
  for (const event of events) {
    const record = event as { type?: unknown; item?: unknown };
    if (record.type === 'turn.started') { turnItems.clear(); continue; }
    const item = record.item as UiToolItem | undefined;
    if (item?.kind !== 'tool' || item.parentItemId !== undefined) continue;
    // A spawn turns background in a later snapshot of the same item.
    if (item.background === true || background.has(item.id)) { background.set(item.id, item); turnItems.delete(item.id); }
    else turnItems.set(item.id, item);
  }
  const named = (items: Iterable<UiToolItem>) => [...items].filter(open)
    .map(item => shorten(item.title && item.title !== item.name ? `${item.name}: ${item.title}` : item.name));
  const tools = named(turnItems.values());
  const subagents = named(background.values());
  if (!tools.length && !subagents.length) return undefined;
  const capped = (names: string[]) => names.length > MAX_NAMES
    ? [...names.slice(0, MAX_NAMES), `${names.length - MAX_NAMES} more`] : names;
  return { ...(tools.length ? { tools: capped(tools) } : {}), ...(subagents.length ? { subagents: capped(subagents) } : {}) };
}

/** The resume sentences for `work`, or undefined. */
export function cutOffSentence(work: CutOffWork | undefined): string | undefined {
  if (!work) return undefined;
  const parts: string[] = [];
  if (work.tools?.length) parts.push(`The restart cut off these tool calls, which have no result: ${work.tools.join('; ')}.`);
  if (work.subagents?.length) parts.push(`These native subagents were still running and stopped: ${work.subagents.join('; ')}. Their partial work is lost; start them again if you still need it.`);
  return parts.join(' ');
}
