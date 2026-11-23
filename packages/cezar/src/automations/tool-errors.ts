import type { ScheduledTaskRefusalCode } from '@open-mercato/cezar-contract/scheduled-tasks';
import type { z } from 'zod';
// hearsay-tools/cezarion#1465: `cezar_schedule_task` and `cezar_scheduled_tasks` refusals.
const scheduleMessages: Record<Extract<ScheduledTaskRefusalCode, 'automations_off' | 'unavailable'>, string> = {
  automations_off: `Automations are off in this cockpit (CEZ_AUTOMATIONS=0), so Squawk cannot schedule a task. Tell the user.`,
  unavailable: `Squawk could not reach its scheduler for this session. Tell the user; scheduling needs a running cockpit.`,
};
export function scheduleRefusal(code: ScheduledTaskRefusalCode, message?: string): { ok: false; code: ScheduledTaskRefusalCode; message: string } {
  return { ok: false, code, message: message ?? scheduleMessages[code as keyof typeof scheduleMessages] ?? 'Invalid arguments.' };
}

const SCHEDULE_FIELD_RULES: Record<string, string> = {
  action: 'must be "list", "show", "update", "pause", "enable" or "cancel"',
  id: 'must be the id of a one-time schedule a list or a create answered',
  archived: 'must be "include" or "only"',
  name: 'must be a string of 1 to 200 characters',
  prompt: 'must be a string of 1 to 100000 characters',
  at: 'must be a UTC time YYYY-MM-DDTHH:MMZ; give at or delay, not both',
  delay: 'must be a duration such as 30m, 6h or 7d; give at or delay, not both',
  latest_start: 'must be a duration such as 30m, 6h or 7d',
  workflow: 'must be a workflow name',
  runner: 'must be a runner name',
  model: 'must be a model id',
  effort: 'must be an effort level',
  enable: 'must be true or false',
};

/** Names the unknown field or the first failing field and its rule, never the value sent. */
export function scheduleInvalidInput(error?: z.ZodError): string {
  const issue = error?.issues[0];
  if (issue?.code === 'unrecognized_keys') return `Unknown field ${issue.keys.map(key => JSON.stringify(key.slice(0, 64))).join(', ')}.`;
  const field = error?.issues.map(entry => entry.path[0]).find((key): key is string => typeof key === 'string' && key in SCHEDULE_FIELD_RULES);
  if (field) return `\`${field}\` ${SCHEDULE_FIELD_RULES[field]}.`;
  return 'The arguments must be a JSON object.';
}
