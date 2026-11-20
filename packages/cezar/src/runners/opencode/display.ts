import type { RunnerEntry } from '@open-mercato/cezar-contract/runners';

/** How the cockpit and server messages name the OpenCode runner (its `display` part). */
export const OPENCODE_DISPLAY = {
  displayName: 'OpenCode',
  modelListName: 'OpenCode',
  modelIdScope: 'provider-spanning',
} as const satisfies Omit<RunnerEntry, 'id'>;
