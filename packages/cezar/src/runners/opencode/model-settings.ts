import { firstConfiguredModel, readNativeSettingsFiles, type AgentModelSettingsStrategy } from '@hearsay-tools/squawk/plugin';

export const opencodeModelSettingsStrategy: AgentModelSettingsStrategy = {
  runner: 'opencode',
  async read(repoRoot, env) {
    return { model: firstConfiguredModel(await readNativeSettingsFiles('opencode', repoRoot, env)) };
  },
};
