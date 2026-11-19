import type { RunnerEntry } from '@open-mercato/cezar-contract/runners';

/** How the cockpit and server messages name the Claude runner (its `display` part). */
export const CLAUDE_DISPLAY = {
  displayName: 'Claude Code',
  modelListName: 'Claude',
  modelIdScope: 'own',
} as const satisfies Omit<RunnerEntry, 'id'>;
