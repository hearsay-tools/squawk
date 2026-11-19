import type { RunnerEntry } from '@open-mercato/cezar-contract/runners';

/** How the cockpit and server messages name the OMP runner (its `display` part). */
export const OMP_DISPLAY = {
  displayName: 'OMP',
  modelListName: 'OMP',
  modelIdScope: 'provider-spanning',
} as const satisfies Omit<RunnerEntry, 'id'>;
