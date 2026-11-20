
/** The model and provider a runner's own settings files name for a new session. */

export interface AgentModelSettings {
  model?: string | undefined;
  provider?: string;
}

/** How one runner reads its native default model (`models.loadSettings` in its definition). */
export interface AgentModelSettingsStrategy {
  readonly runner: string;
  read(repoRoot: string, env: NodeJS.ProcessEnv): Promise<AgentModelSettings>;
}
