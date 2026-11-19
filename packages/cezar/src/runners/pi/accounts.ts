import type { RunnerAccounts } from '../../core/runner-definition.ts';
import type { AgentHomePaths } from '../../core/runner-config-files.ts';

/** Pi's account data (the `accounts` part). Data only: the definition and the account
 *  readers consume it, so importing it loads no code. */
export const PI_ACCOUNTS = {
  layout: { envVar: 'PI_CODING_AGENT_DIR', defaultBindsHome: false, stateFile: 'in-home' },
  dirMarkers: ['auth.json', 'settings.json', 'models.json', 'sessions'],
  homeSlot: 'pi',
} as const satisfies RunnerAccounts & { homeSlot: keyof AgentHomePaths };
