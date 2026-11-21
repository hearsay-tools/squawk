import type { RunnerAccountsData } from '../../core/runner-definition.ts';
// Named accounts ship separately (hearsay-tools/squawk#4003).
export const ANTIGRAVITY_ACCOUNTS = {
  layout: { envVar: null, defaultBindsHome: false, stateFile: 'in-home' },
  dirMarkers: ['antigravity-acp'], homeSlot: 'antigravity',
} as const satisfies RunnerAccountsData;
