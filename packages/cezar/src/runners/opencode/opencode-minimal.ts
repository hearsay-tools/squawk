import { buildChildEnv, opencodeToolGrantFields } from '@hearsay-tools/squawk/plugin/runtime';
import type { AgentRunSpec } from '@hearsay-tools/squawk/plugin';
import { ciOpenCodeEnv, isObject, suppliedOpenCodeConfig } from './opencode-runtime-config.ts';
import { opencodeTaskScopeEnv } from './opencode-task-scope.ts';

/** `opencode serve` flags for a minimal session (`AgentRunSpec.minimal`): no external plugins. */
export const OPENCODE_MINIMAL_SERVE_ARGS = ['--pure'] as const;

/** The `prompt_async` tools map of a minimal session. OpenCode turns it into a session
 *  permission rule (`*` deny). Session rules come after an agent's own permission rules, and the
 *  last matching rule wins, so a configured agent cannot allow a tool back (OpenCode 1.19.4). */
export const OPENCODE_MINIMAL_PROMPT_TOOLS = { '*': false } as const;

/** The same rule on `POST /session`, and on `PATCH /session/{id}` (which appends) when a session
 *  is resumed, so a turn that a skill command opens, which takes no tools map, is denied too. */
export const OPENCODE_MINIMAL_SESSION_PERMISSION = [{ permission: '*', action: 'deny', pattern: '*' }] as const;

/** Env switches for a minimal session: no project config, no Claude Code files (CLAUDE.md,
 *  Claude skills) and no external skills. Default plugins stay: OpenCode 1.19.4 ships its Codex
 *  and Copilot sign-in loaders as default plugins, so turning them off breaks those logins. */
export const OPENCODE_MINIMAL_ENV = {
  OPENCODE_DISABLE_PROJECT_CONFIG: '1',
  OPENCODE_DISABLE_CLAUDE_CODE: '1',
  OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
} as const;

/**
 * Adds the minimal-session switches to an OpenCode session's extra env. The runner maps no
 * `toolGrant`, so the runtime config also turns every tool off (`tools: {"*": false}`) and denies
 * every permission (`permission: {"*": "deny"}`), in place of any supplied entries. OpenCode gives
 * this runtime config precedence over its config files, but an agent's own permission rules come
 * after it, so the prompt body also sends `OPENCODE_MINIMAL_PROMPT_TOOLS`. MCP servers named in
 * the user's global config, the global AGENTS.md and configured `instructions` still load.
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

/** The `opencode serve` argv and child env for a session: Squawk's tools, the governed task scope
 *  and the minimal-session switches, merged in that order. */
export function opencodeServeLaunch(spec: AgentRunSpec, port: number): { args: string[]; env: NodeJS.ProcessEnv } {
  const extraEnv = opencodeMinimalEnv(opencodeTaskScopeEnv(ciOpenCodeEnv(spec), spec.restrictCrossSessionMessaging), spec.minimal);
  return {
    args: ['serve', '--hostname', '127.0.0.1', '--port', String(port), ...(spec.minimal ? OPENCODE_MINIMAL_SERVE_ARGS : [])],
    env: buildChildEnv({ backend: 'opencode', extraEnv }),
  };
}

/** The `POST /session` body of a new session: its title, its tool grant fields and, for a minimal
 *  session, the deny rule. */
export function opencodeSessionBody(spec: AgentRunSpec): Record<string, unknown> {
  return {
    title: 'cezar task',
    ...opencodeToolGrantFields(spec.toolGrant),
    ...(spec.minimal ? { permission: OPENCODE_MINIMAL_SESSION_PERMISSION } : {}),
  };
}
