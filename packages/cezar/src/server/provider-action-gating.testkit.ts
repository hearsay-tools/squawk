import { ProviderAuthService, type ProviderId } from '../core/provider-auth.ts';
import { defaultWorkspaceConfig, type WorkspaceConfig } from '../workspace/config.ts';

/** Engine-free helpers shared by the provider gate's module and engine tests. */
export const DISABLED_MESSAGE = 'Codex is disabled. Enable it in Settings → Agent defaults → Providers.';

export const memoryWorkspaceConfig = (disabledProviders: ProviderId[] = ['codex']) => {
  let config: WorkspaceConfig = { ...defaultWorkspaceConfig(), disabledProviders };
  return {
    load: async () => config,
    mergeWrite: async (mutator: (current: WorkspaceConfig) => WorkspaceConfig | void) => {
      config = mutator(config) ?? config;
      return config;
    },
  };
};

export const providerAuth = () => new ProviderAuthService({
  platform: 'linux',
  runCommand: async (executable) => {
    if (executable === 'claude') return { stdout: '{"loggedIn":true}', stderr: '', exitCode: 0 };
    if (executable === 'codex') return { stdout: 'Logged in using ChatGPT', stderr: '', exitCode: 0 };
    return {
      stdout: '┌  Credentials ~/.local/share/opencode/auth.json\n└  1 credential',
      stderr: '',
      exitCode: 0,
    };
  },
});
