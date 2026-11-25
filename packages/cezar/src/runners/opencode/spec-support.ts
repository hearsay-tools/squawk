import { SQUAWK_SIDE_SPEC_SUPPORT, type AgentRunSpecSupport } from '@hearsay-tools/squawk/plugin';

// Data only: the adapter class and the definition read this value, so importing it loads no adapter.

/**
 * What `opencode serve` receives from each `AgentRunSpec` field (#284).
 * OpenCode's own permission config governs tool access and this adapter maps no
 * per-tool allowlist, so `toolGrant` is declared dropped rather than mapped (spec
 * 2026-07-17-permission-modes). Resume GETs `/session/{id}` and prompts it; a 404 opens one
 * fresh session. Held against the recorded HTTP requests by the harness parity matrix.
 */
export const OPENCODE_SPEC_SUPPORT: AgentRunSpecSupport = {
  squawkTools: { honored: true, via: 'merged OPENCODE_CONFIG_CONTENT local mcp entry' },
  ...SQUAWK_SIDE_SPEC_SUPPORT,
  systemPrompt: { honored: true, via: 'prepended to the opening prompt_async text through prependSystemPrompt' },
  skill: { honored: true, via: 'POST session command; acknowledgement on SSE' },
  resumeFallbackSkill: { honored: true, via: 'native opening trigger only when bootstrap opens a fresh session' },
  userPrompt: { honored: true, via: 'prompt_async text part' },
  images: { honored: false, reason: 'the adapter posts text parts only; image blocks are dropped' },
  cwd: { honored: true, via: 'opencode serve spawn cwd; the session is bound to it' },
  toolGrant: { honored: false, reason: 'OpenCode permission config governs tool access and bash; this runner answers its built-in default asks and routes configured asks to the cockpit, but maps no per-tool allowlist, so no command-prefix restriction either' },
  minimal: { honored: true, via: 'opencode serve --pure; OPENCODE_DISABLE_PROJECT_CONFIG, OPENCODE_DISABLE_CLAUDE_CODE and OPENCODE_DISABLE_EXTERNAL_SKILLS (default plugins stay: they carry the Codex and Copilot sign-in loaders); OPENCODE_CONFIG_CONTENT tools {"*": false} and permission {"*": "deny"}, and a "*" deny session rule (POST /session permission, and prompt_async tools {"*": false}) that outranks agent permission rules and covers skill command turns, since the runner maps no toolGrant; a resumed session gets it through PATCH /session/{id} before its first turn. Still loaded: MCP servers in the user\'s global config, the global AGENTS.md and configured instructions; the session is saved' },
  restrictCrossSessionMessaging: { honored: true, via: 'the opencode-task-scope.mjs plugin appended to the OPENCODE_CONFIG_CONTENT plugin list; its tool.execute.before hook refuses a task call whose task_id names a session outside the caller\'s session tree, and keeps subagents (hearsay-tools/cezarion#2279)' },
  additionalDirectories: { honored: false, reason: 'the server works from cwd; no extra-root mapping' },
  env: { honored: true, via: 'merged over the child env through buildChildEnv' },
  model: { honored: true, via: 'prompt_async model { providerID, modelID }, split from provider/model' },
  effort: { honored: true, via: 'prompt_async variant, canonical level' },
  timeoutMs: { honored: true, via: 'wall-clock kill switch on the child process' },
  sessionId: { honored: true, via: 'GET /session/{id} when resume is set; a fresh POST /session mints its own id' },
  resume: { honored: true, via: 'GET /session/{id} in place of POST /session; 404 falls back to a fresh session' },
  resumeFallbackSystemPrompt: { honored: true, via: 'opening prependSystemPrompt of a fresh POST /session when GET /session/{id} returns 404 on resume' },
};
