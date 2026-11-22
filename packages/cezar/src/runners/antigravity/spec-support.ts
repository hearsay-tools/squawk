import type { AgentRunSpecSupport } from '../../core/agent-runner.ts';
import { SQUAWK_SIDE_SPEC_SUPPORT } from '../../core/agent-runner-values.ts';
export const ANTIGRAVITY_SPEC_SUPPORT: AgentRunSpecSupport = {
  ...SQUAWK_SIDE_SPEC_SUPPORT,
  systemPrompt: { honored: true, via: '_meta.antigravity.systemPrompt.append on session/new, which the CLI saves; a resume prepends it to the opening turn' },
  squawkTools: { honored: true, via: 'private loopback HTTP MCP bridge named squawk in session/new and session/resume' },
  userPrompt: { honored: true, via: 'session/prompt text content' },
  skill: { honored: true, via: 'leading /id args in session/prompt' },
  resumeFallbackSkill: { honored: true, via: 'leading /id args when opening a fresh session' },
  images: { honored: true, via: 'session/prompt image content' },
  cwd: { honored: true, via: 'session/new cwd and the only active workspace; native command cwd is the task checkout' },
  toolGrant: { honored: true, via: 'default mode plus fail-closed session/request_permission policy' },
  restrictCrossSessionMessaging: { honored: false, reason: 'The Antigravity CLI send_message tool reaches only the session\'s own subagents; it has no tool that messages another session' },
  minimal: { honored: false, reason: 'The Antigravity CLI offers no minimal or no-context launch mode' },
  additionalDirectories: { honored: false, reason: 'The CLI --add-dir flag is not verified to keep the task checkout as command cwd; the registry server let extra roots displace it' },
  env: { honored: true, via: 'buildChildEnv over the runner allow-list' },
  model: { honored: true, via: 'session/set_config_option model' },
  effort: { honored: true, via: 'session/set_config_option thought_level category' },
  timeoutMs: { honored: true, via: 'wall-clock process-tree deadline' },
  sessionId: { honored: true, via: 'saved sessionId on session/resume; session/new mints its own UUID' },
  resume: { honored: true, via: 'session/resume without history replay; the saved system prompt carries over' },
  resumeFallbackSystemPrompt: { honored: false, reason: 'a failed session/resume fails the step; there is no fresh-session fallback' },
};
