import type { RunnerEntry } from '@open-mercato/cezar-contract/runners';

/** How the cockpit and server messages name the Pi runner (its `display` part). */
export const PI_DISPLAY = {
  displayName: 'pi',
  modelListName: 'Pi',
  modelIdScope: 'provider-spanning',
} as const satisfies Omit<RunnerEntry, 'id'>;
