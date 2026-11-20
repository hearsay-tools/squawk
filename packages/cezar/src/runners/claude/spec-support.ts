import type { AgentRunSpecSupport } from '../../core/agent-runner.ts';
import { SQUAWK_SIDE_SPEC_SUPPORT } from '../../core/agent-runner-values.ts';

// Data only: the adapter class and the definition read this value, so importing it loads no adapter.

/**
 * What the claude CLI receives from each `AgentRunSpec` field (#284). Every
 * field has a native flag or a stdin/spawn channel — this is the runner the
 * spec was shaped around. Held against `--allowedTools`/stdin recordings by
 * the harness parity matrix; change a row only with the mapping in `buildArgs`.
 */
export const CLAUDE_SPEC_SUPPORT: AgentRunSpecSupport = {
  squawkTools: { honored: true, via: '--mcp-config and generated --allowedTools name' },
  ...SQUAWK_SIDE_SPEC_SUPPORT,
  systemPrompt: { honored: true, via: '--append-system-prompt' },
  skill: { honored: true, via: 'last text block /id args; context in earlier blocks' },
  resumeFallbackSkill: { honored: true, via: 'native opening trigger only when bootstrap opens a fresh session' },
  userPrompt: { honored: true, via: 'text block of the first stream-json user message on stdin' },
  images: { honored: true, via: 'image blocks ahead of the text in the first stdin message' },
  cwd: { honored: true, via: 'spawn cwd' },
  toolGrant: { honored: true, via: '--allowedTools, through buildAllowedTools, with a bashAllowlist as Bash(<prefix>:*) entries, one per prefix; unset sends none; an empty list sends --tools "" so no built-in tool exists, and --allowedTools names only the Squawk tools' },
  restrictCrossSessionMessaging: { honored: false, reason: 'SendMessage and ListAgents also reach the session\'s own subagents, so no outbound tool is separate from subagent messaging; inbound messages from other sessions are refused on every launch (crossSessionInbound, D3)' },
  minimal: { honored: true, via: '--safe-mode (no CLAUDE.md, plugins, hooks, MCP servers or custom agents; auth and model selection stay), --disable-slash-commands (no skills or commands) and --no-session-persistence; not --bare, which accepts only API-key auth. Managed (policy) settings still apply' },
  additionalDirectories: { honored: true, via: '--add-dir, once per directory' },
  env: { honored: true, via: 'merged over the child env through buildChildEnv' },
  model: { honored: true, via: '--model' },
  effort: { honored: true, via: '--effort, canonical level' },
  timeoutMs: { honored: true, via: 'wall-clock kill switch on the child process' },
  sessionId: { honored: true, via: '--session-id, or --resume when resume is set' },
  resume: { honored: true, via: '--resume <sessionId> in place of --session-id' },
  resumeFallbackSystemPrompt: { honored: false, reason: 'Continue already resends spec.systemPrompt on every process; a separate fallback prompt is unused' },
};
