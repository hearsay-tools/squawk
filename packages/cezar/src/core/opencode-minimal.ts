import { isObject, suppliedOpenCodeConfig } from './opencode-runtime-config.ts';

/** `opencode serve` flags for a minimal session (`AgentRunSpec.minimal`): no external plugins. */
export const OPENCODE_MINIMAL_SERVE_ARGS = ['--pure'] as const;

/** Env switches for a minimal session: no project config, no Claude Code files (CLAUDE.md,
 *  Claude skills), no external skills and no default plugins. */
export const OPENCODE_MINIMAL_ENV = {
  OPENCODE_DISABLE_PROJECT_CONFIG: '1',
  OPENCODE_DISABLE_CLAUDE_CODE: '1',
  OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
  OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
} as const;

/**
 * Adds the minimal-session switches to an OpenCode session's extra env. The runner maps no
 * `toolGrant`, so the runtime config also turns every tool off (`tools: {"*": false}`) and denies
 * every permission (`permission: {"*": "deny"}`), in place of any supplied entries. OpenCode gives
 * this runtime config precedence over its config files. MCP servers named in the user's global config still start.
 */
export function opencodeMinimalEnv(
  env: Record<string, string> | undefined,
  minimal: boolean | undefined,
): Record<string, string> | undefined {
  if (!minimal) return env;
  const config = suppliedOpenCodeConfig(env, 'tools', isObject, 'Minimal session unavailable: invalid supplied OpenCode runtime configuration');
  return {
    ...env,
    ...OPENCODE_MINIMAL_ENV,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...config, tools: { '*': false }, permission: { '*': 'deny' } }),
  };
}
