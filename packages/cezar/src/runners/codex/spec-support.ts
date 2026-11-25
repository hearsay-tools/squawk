import { type AgentRunSpecSupport, SQUAWK_SIDE_SPEC_SUPPORT } from '@hearsay-tools/squawk/plugin';

// Data only: the adapter class and the definition read this value, so importing it loads no adapter.

/**
 * What the codex app-server receives from each `AgentRunSpec` field (#284).
 * Tool access does not cross this wire: managed permissions belong to Codex;
 * unmanaged sessions use Squawk's sandbox choice. The app-server has no per-tool
 * allowlist, so `toolGrant` is declared dropped rather than mapped (spec
 * 2026-07-17-permission-modes). Held against the recorded JSON-RPC by the harness parity matrix.
 */
export const CODEX_SPEC_SUPPORT: AgentRunSpecSupport = {
  squawkTools: { honored: true, via: 'thread/start and thread/resume dotted mcp_servers config with env_vars and default_tools_approval_mode approve' },
  ...SQUAWK_SIDE_SPEC_SUPPORT,
  systemPrompt: { honored: true, via: 'prepended to the opening turn/start input through prependSystemPrompt' },
  skill: { honored: true, via: 'turn/start structured skill item with listed path and text arguments' },
  resumeFallbackSkill: { honored: true, via: 'native opening trigger only when bootstrap opens a fresh session' },
  userPrompt: { honored: true, via: 'turn/start input text' },
  images: { honored: false, reason: 'the adapter sends text input items only; image blocks are dropped' },
  cwd: { honored: true, via: 'spawn cwd, and the thread/start / thread/resume cwd' },
  toolGrant: { honored: false, reason: 'no per-tool allowlist on the app-server, so no command-prefix restriction either; managed permissions and approval policy belong to Codex' },
  restrictCrossSessionMessaging: { honored: true, via: 'thread/start and thread/resume config features.agent_message_board=false; multi-agent tools reach only the session\'s own agents and stay as configured (hearsay-tools/cezarion#2279)' },
  minimal: { honored: true, via: 'thread/start and thread/resume config features.hooks, features.plugins, features.apps, features.memories and features.multi_agent false, project_doc_max_bytes 0 (no AGENTS.md) and web_search disabled; sandbox read-only under a confirmed unmanaged policy or a failed requirements read, since the app-server ignores toolGrant (a discovered managed policy stays Codex\'s); thread/start ephemeral. Codex 0.164.0 has no override that stops skills or the user\'s MCP servers' },
  additionalDirectories: { honored: false, reason: 'no extra-root mapping; managed filesystem permissions belong to Codex' },
  env: { honored: true, via: 'merged over the child env through buildCodexAppServerEnv' },
  model: { honored: true, via: 'thread/start and thread/resume model' },
  effort: { honored: true, via: 'turn/start effort, canonical level' },
  timeoutMs: { honored: true, via: 'wall-clock kill switch on the child process' },
  sessionId: { honored: true, via: 'thread/resume threadId when resume is set; a fresh thread/start mints its own thread id' },
  resume: { honored: true, via: 'thread/resume in place of thread/start' },
  resumeFallbackSystemPrompt: { honored: false, reason: 'thread/resume fails a missing thread; the adapter does not open a replacement thread' },
};
