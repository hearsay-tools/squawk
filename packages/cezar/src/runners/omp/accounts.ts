import type { RunnerAccounts } from '../../core/runner-definition.ts';
import type { AgentHomePaths } from '../../agent-config/catalog.ts';

/** OMP's account data (the `accounts` part). Data only: the definition and the account
 *  readers consume it, so importing it loads no code. */
export const OMP_ACCOUNTS = {
  // omp selects a login by profile NAME under its own root, not by folder, so it carries no named
  // accounts; a host `OMP_PROFILE` still moves its discovered default (`agentHomePaths`).
  layout: { envVar: null, defaultBindsHome: false, stateFile: 'in-home' },
  // omp carries no named accounts; the discovered default is an agent dir.
  dirMarkers: ['agent.db', 'config.yml', 'sessions'],
  homeSlot: 'omp',
} as const satisfies RunnerAccounts & { homeSlot: keyof AgentHomePaths };
