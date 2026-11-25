import { type AgentRunSpecSupport, SQUAWK_SIDE_SPEC_SUPPORT } from '@hearsay-tools/squawk/plugin';

// Data only: the adapter class and the definition read this value, so importing it loads no adapter.

/** OMP's flags for a minimal session (`AgentRunSpec.minimal`): no discovered extensions, skills,
 *  rules or context files, no LSP, no saved session and no title model call. */
export const OMP_MINIMAL_ARGS = ['--no-extensions', '--no-skills', '--no-rules', '--no-context-files',
  '--no-lsp', '--no-session', '--no-title'] as const;

/**
 * What the omp CLI receives from each `AgentRunSpec` field (#284, spec § Spawn and spec
 * support). Held against the mock's recorded argv and RPC by the harness parity matrix.
 */
export const OMP_SPEC_SUPPORT: AgentRunSpecSupport = {
  squawkTools: { honored: true, via: `explicit CI --extension; the Squawk tools admitted when --tools is set` },
  ...SQUAWK_SIDE_SPEC_SUPPORT,
  systemPrompt: { honored: true, via: '--append-system-prompt' },
  skill: { honored: true, via: 'RPC prompt /skill:id args' },
  resumeFallbackSkill: { honored: true, via: 'native opening trigger only when bootstrap opens a fresh session' },
  userPrompt: { honored: true, via: 'RPC prompt.message' },
  images: { honored: true, via: "RPC prompt.images ({type:'image', data, mimeType})" },
  cwd: { honored: true, via: 'spawn cwd' },
  toolGrant: { honored: true, via: "--tools, mapped onto OMP names; unmapped names dropped (fail closed); a bashAllowlist has no prefix equivalent, so bash is dropped from --tools (Pi's rule), and an unset grant names OMP's default set first so bash can be left out. --tools filters built-in tools only: MCP and extension tools stay callable under a narrowed list (hearsay-tools/squawk#1357)" },
  restrictCrossSessionMessaging: {
    honored: false,
    reason: 'OMP 18.13.1 has no cross-session tool in its default set; its irc tool is an in-process bus that reaches only agents inside the same OMP process, so subagent messaging and task stay (hearsay-tools/cezarion#2279)',
  },
  minimal: { honored: true, via: `${OMP_MINIMAL_ARGS.join(' ')}; explicit --extension paths still load. OMP 18.13.1 has no flag that stops MCP servers, so the user's MCP servers still connect` },
  additionalDirectories: { honored: true, via: '--add-dir per directory; an omp build that rejects --add-dir is respawned once without it, with a v1 note (Ruling 22)' },
  env: { honored: true, via: 'merged over the child env through buildChildEnv' },
  model: { honored: true, via: '--model provider/model' },
  effort: { honored: true, via: '--thinking, canonical level' },
  timeoutMs: { honored: true, via: 'wall-clock kill switch' },
  sessionId: { honored: true, via: '--resume <id> when resume is set; a fresh session mints its own id, reported from get_state' },
  resume: { honored: true, via: '--resume in place of a fresh session' },
  resumeFallbackSystemPrompt: { honored: false, reason: 'Continue already resends spec.systemPrompt on every process; a separate fallback prompt is unused' },
};
