import type { RunnerAccountsData } from '@hearsay-tools/squawk/plugin';

/** Pi's account data (the `accounts` part's data half). Data only: the definition and the account
 *  readers consume it, so importing it loads no code. */
export const PI_ACCOUNTS = {
  layout: { envVar: 'PI_CODING_AGENT_DIR', defaultBindsHome: false, stateFile: 'in-home' },
  dirMarkers: ['auth.json', 'settings.json', 'models.json', 'sessions'],
  homeSlot: 'pi',
} as const satisfies RunnerAccountsData;
