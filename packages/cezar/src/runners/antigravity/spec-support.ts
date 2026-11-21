import type { AgentRunSpecSupport } from '../../core/agent-runner.ts';
import { SQUAWK_SIDE_SPEC_SUPPORT } from '../../core/agent-runner-values.ts';
export const ANTIGRAVITY_SPEC_SUPPORT: AgentRunSpecSupport = {
  ...SQUAWK_SIDE_SPEC_SUPPORT,
  systemPrompt: { honored: true, via: '_meta.antigravity.systemPrompt.append on new and resume' },
  squawkTools: { honored: true, via: 'private loopback HTTP MCP bridge in session/new and session/resume' },
  userPrompt: { honored: true, via: 'session/prompt text content' },
  skill: { honored: true, via: 'leading /id args in session/prompt' },
  resumeFallbackSkill: { honored: true, via: 'leading /id args when opening a fresh session' },
  images: { honored: true, via: 'session/prompt image content' },
  cwd: { honored: true, via: 'spawn cwd and session/new cwd' },
  toolGrant: { honored: true, via: 'default mode plus fail-closed session/request_permission policy' },
  restrictCrossSessionMessaging: { honored: false, reason: 'Antigravity 1.5.0 has no cross-session messaging tool' },
  minimal: { honored: false, reason: 'Antigravity 1.5.0 offers no minimal or no-context launch mode' },
  additionalDirectories: { honored: true, via: '_meta additionalDirectories in session/new and resume' },
  env: { honored: true, via: 'buildChildEnv over the runner allow-list' },
  model: { honored: true, via: 'session/set_config_option model' },
  effort: { honored: true, via: 'session/set_config_option thought_level category' },
  timeoutMs: { honored: true, via: 'wall-clock process-tree deadline' },
  sessionId: { honored: true, via: 'saved sessionId on session/resume; session/new mints its own UUID' },
  resume: { honored: true, via: 'session/resume without history replay' },
  resumeFallbackSystemPrompt: { honored: false, reason: 'system prompt is resent; no fresh-session fallback' },
};
