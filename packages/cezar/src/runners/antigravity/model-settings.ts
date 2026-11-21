import type { AgentModelSettingsStrategy } from '../../core/runner-model-settings.ts';
export const antigravityModelSettings: AgentModelSettingsStrategy = {
  runner: 'antigravity', read: async (_cwd, env) => ({ model: env.AGY_ACP_DEFAULT_MODEL }),
};
