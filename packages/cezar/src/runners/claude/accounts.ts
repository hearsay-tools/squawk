import type { RunnerAccountsData } from '@hearsay-tools/squawk/plugin';

/** Claude's account data (the `accounts` part's data half). Data only: the definition and the account
 *  readers consume it, so importing it loads no code. */
export const CLAUDE_ACCOUNTS = {
  layout: { envVar: 'CLAUDE_CONFIG_DIR', defaultBindsHome: true, stateFile: 'beside-home' },
  // `.claude.json` sits INSIDE the dir once it is overridden (see `claudeStateFilePath`), which
  // is exactly the case being probed here.
  dirMarkers: ['.claude.json', 'settings.json', 'projects', 'sessions'],
  homeSlot: 'claude',
} as const satisfies RunnerAccountsData;
