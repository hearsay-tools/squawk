import type { RunnerEntry } from '@open-mercato/cezar-contract/runners';

/** How the cockpit and server messages name the Codex runner (its `display` part). */
export const CODEX_DISPLAY = {
  displayName: 'Codex',
  modelListName: 'Codex',
  modelIdScope: 'own',
} as const satisfies Omit<RunnerEntry, 'id'>;
