import type { RunnerAccountsData } from '@hearsay-tools/squawk/plugin';
export const ANTIGRAVITY_ACCOUNTS = {
  layout: { envVar: 'GEMINI_HOME', defaultBindsHome: false, stateFile: 'in-home',
    envPaths: { HOME: '.squawk-home', USERPROFILE: '.squawk-home', XDG_CONFIG_HOME: '.squawk-home/.config' } },
  dirMarkers: ['antigravity-cli', 'antigravity-acp'], homeSlot: 'antigravity',
} as const satisfies RunnerAccountsData;
