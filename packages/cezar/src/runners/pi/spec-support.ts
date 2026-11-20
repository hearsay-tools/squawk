import type { AgentRunSpecSupport } from '../../core/agent-runner.ts';
import { SQUAWK_SIDE_SPEC_SUPPORT } from '../../core/agent-runner-values.ts';

// Data only: the adapter class and the definition read this value, so importing it loads no adapter.

/** pi's flags for a minimal session: no discovered extensions, skills, prompt templates, themes,
 *  context files or MCP servers, and no saved session. Explicit
 *  `--extension` paths still load. */
export const PI_MINIMAL_ARGS = ['--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes',
  '--no-context-files', '--no-mcp', '--no-session'] as const;

/**
 * What the pi CLI receives from each `AgentRunSpec` field (#284). Tool names
 * are mapped onto pi's own through `piTools`. An unset grant sends no tool
 * flags; a grant's list takes one of three paths (hearsay-tools/cezarion#1305). A list holding every default
 * built-in and nothing beyond pi's default set sends no allowlist:
 * `--no-builtin-tools` plus the default-tools extension, which activates the
 * listed built-ins, so MCP and extension tools stay callable. A narrowed list
 * keeps the `--tools` allowlist; naming any other tool (an `mcp__` tool, for
 * one) narrows it, so that grant stays limited to the named tools. A list that
 * maps to nothing fails closed: `--tools` with
 * only the Squawk tools, or `--no-tools`. pi has no command-prefix equivalent
 * for a `bashAllowlist`, so a list with one narrows to `--tools` and drops
 * `bash` (fail closed) rather than widening. Held against the recorded
 * argv and RPC prompt by the harness parity matrix.
 */
export const PI_SPEC_SUPPORT: AgentRunSpecSupport = {
  squawkTools: { honored: true, via: 'explicit CI --extension and selected tool admission' },
  ...SQUAWK_SIDE_SPEC_SUPPORT,
  systemPrompt: { honored: true, via: '--append-system-prompt' },
  skill: { honored: true, via: 'RPC prompt /skill:id args with context after arguments' },
  resumeFallbackSkill: { honored: true, via: 'native opening trigger only when bootstrap opens a fresh session' },
  userPrompt: { honored: true, via: 'RPC prompt message' },
  images: { honored: true, via: 'RPC prompt images' },
  cwd: { honored: true, via: 'spawn cwd' },
  toolGrant: { honored: true, via: `mapped through piTools: the default list sends --no-builtin-tools and names its built-ins to the default-tools extension; a narrowed list, or one naming a tool outside the pi default set, sends --tools; a list that maps to nothing sends --tools with the Squawk tools only, or --no-tools; a bashAllowlist has no prefix equivalent, so it narrows the list to --tools without bash (fail closed); unset sends no tool flags` },
  restrictCrossSessionMessaging: { honored: false, reason: 'pi 1.4.0 has no built-in cross-session tool, and an extension\'s name cannot be discovered as messaging; the subagent extension stays (hearsay-tools/cezarion#2279)' },
  minimal: { honored: true, via: `${PI_MINIMAL_ARGS.join(' ')}, and no project-skills extension; explicit --extension paths (the Squawk tools, the retry extension) still load` },
  additionalDirectories: { honored: false, reason: 'pi has no extra-root flag' },
  env: { honored: true, via: 'merged over the child env through buildChildEnv' },
  model: { honored: true, via: '--model provider/model' },
  effort: { honored: true, via: '--thinking, canonical level' },
  timeoutMs: { honored: true, via: 'wall-clock kill switch on the child process' },
  sessionId: { honored: true, via: '--session-id, or --session when resume is set' },
  resume: { honored: true, via: '--session <sessionId> in place of --session-id' },
  resumeFallbackSystemPrompt: { honored: false, reason: 'Continue already resends spec.systemPrompt on every process; a separate fallback prompt is unused' },
};
