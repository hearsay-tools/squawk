import { firstConfiguredModel, readNativeSettingsFiles } from '@hearsay-tools/squawk/plugin/model-settings';
import type { AgentModelSettingsStrategy } from '@hearsay-tools/squawk/plugin';

export const opencodeModelSettingsStrategy: AgentModelSettingsStrategy = {
  runner: 'opencode',
  async read(repoRoot, env) {
    return { model: firstConfiguredModel(await readNativeSettingsFiles('opencode', repoRoot, env)) };
  },
};
