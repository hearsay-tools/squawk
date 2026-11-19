import type { RunnerAccounts } from '../../core/runner-definition.ts';
import type { AgentHomePaths } from '../../agent-config/catalog.ts';

/** Claude's account data (the `accounts` part). Data only: the definition and the account
 *  readers consume it, so importing it loads no code. */
export const CLAUDE_ACCOUNTS = {
  layout: { envVar: 'CLAUDE_CONFIG_DIR', defaultBindsHome: true, stateFile: 'beside-home' },
  // `.claude.json` sits INSIDE the dir once it is overridden (see `claudeStateFilePath`), which
  // is exactly the case being probed here.
  dirMarkers: ['.claude.json', 'settings.json', 'projects', 'sessions'],
  homeSlot: 'claude',
} as const satisfies RunnerAccounts & { homeSlot: keyof AgentHomePaths };
