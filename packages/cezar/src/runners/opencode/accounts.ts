import type { RunnerAccounts } from '../../core/runner-definition.ts';
import type { AgentHomePaths } from '../../core/runner-config-files.ts';

/** OpenCode's account data (the `accounts` part). Data only: the definition and the account
 *  readers consume it, so importing it loads no code. */
export const OPENCODE_ACCOUNTS = {
  layout: { envVar: null, defaultBindsHome: false, stateFile: 'in-home' },
  // OpenCode cannot carry profiles (`profileEnvVar('opencode')` is null); the discovered config
  // dir is probed, but nothing it holds marks a login.
  dirMarkers: [],
  homeSlot: 'opencodeConfig',
} as const satisfies RunnerAccounts & { homeSlot: keyof AgentHomePaths };
