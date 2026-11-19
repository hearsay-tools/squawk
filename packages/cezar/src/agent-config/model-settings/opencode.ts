import { firstConfiguredModel, readNativeSettingsFiles } from './shared.ts';
import type { AgentModelSettingsStrategy } from '../../core/runner-model-settings.ts';

export const opencodeModelSettingsStrategy: AgentModelSettingsStrategy = {
  runner: 'opencode',
  async read(repoRoot, env) {
    return { model: firstConfiguredModel(await readNativeSettingsFiles('opencode', repoRoot, env)) };
  },
};
