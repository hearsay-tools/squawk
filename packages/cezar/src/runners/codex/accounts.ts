import type { RunnerAccountsData } from '../../core/runner-definition.ts';

/** Codex's account data (the `accounts` part's data half). Data only: the definition and the account
 *  readers consume it, so importing it loads no code. */
export const CODEX_ACCOUNTS = {
  layout: { envVar: 'CODEX_HOME', defaultBindsHome: true, stateFile: 'in-home' },
  dirMarkers: ['auth.json', 'config.toml'],
  homeSlot: 'codex',
} as const satisfies RunnerAccountsData;
