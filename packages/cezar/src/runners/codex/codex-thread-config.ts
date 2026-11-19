import { squawkToolEnvNames } from '../../ci-wait/tool-catalog.ts';
import type { AgentRunSpec } from '../../core/agent-runner.ts';

/** Config overrides for a minimal session (`AgentRunSpec.minimal`): no hooks, plugins, apps,
 *  memories, subagents, AGENTS.md or web search. */
export const CODEX_MINIMAL_CONFIG = {
  'features.hooks': false,
  'features.plugins': false,
  'features.apps': false,
  'features.memories': false,
  'features.multi_agent': false,
  project_doc_max_bytes: 0,
  web_search: 'disabled',
} as const;

/**
 * The dotted config overrides that `thread/start` and `thread/resume` carry for a session, or
 * undefined when it needs none. No global config file is written. Governed sessions keep
 * multi-agent and lose only the cross-thread message board (hearsay-tools/cezarion#2279).
 */
export function codexThreadConfig(spec: AgentRunSpec, restrictNetwork: boolean): Record<string, unknown> | undefined {
  const config = {
    ...(restrictNetwork ? { 'sandbox_workspace_write.network_access': false } : {}),
    ...(spec.restrictCrossSessionMessaging ? { 'features.agent_message_board': false } : {}),
    ...(spec.minimal ? CODEX_MINIMAL_CONFIG : {}),
    // hearsay-tools/cezarion#1294: Codex asks before every MCP tool call unless the
    // server's mode is `approve`, and Squawk's own tools must never wait on that.
    // approval_policy stays the user's (#381); older Codex ignores the unknown key.
    ...(spec.squawkTools ? { [`mcp_servers.${spec.squawkTools.name}`]: { command: spec.squawkTools.command, args: spec.squawkTools.args, env_vars: squawkToolEnvNames(spec.env ?? {}), default_tools_approval_mode: 'approve' } } : {}),
  };
  return Object.keys(config).length > 0 ? config : undefined;
}
