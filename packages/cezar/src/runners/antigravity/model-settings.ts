import type { AgentModelSettingsStrategy } from '@hearsay-tools/squawk/plugin';
export const antigravityModelSettings: AgentModelSettingsStrategy = {
  runner: 'antigravity', read: async (_cwd, env) => ({ model: env.AGY_ACP_DEFAULT_MODEL }),
};
