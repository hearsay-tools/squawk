import { fileURLToPath } from 'node:url';
import { parseEffort } from '@open-mercato/cezar-contract/effort';
import type { AgentRunSpec, ToolGrant } from './agent-runner.ts';
import { unknownToolGrant } from './agent-runner.ts';
import { squawkToolNames } from '../ci-wait/tool-catalog.ts';

export function buildPiArgs(spec: AgentRunSpec): string[] {
  // pi loads a repo's .pi/skills and .agents/skills only for a trusted folder; the project-skills
  // extension offers them to an untrusted one without trusting it (hearsay-tools/cezarion#1295).
  const args = ['--mode', 'rpc', '--extension', piDegradedServiceRetryExtensionPath(), '--extension', piProjectSkillsExtensionPath()];
  if (spec.squawkTools) args.push('--extension', fileURLToPath(new URL('../../scripts/pi-ci-wait.mjs', import.meta.url)));
  if (spec.sessionId) args.push(spec.resume ? '--session' : '--session-id', spec.sessionId);
  if (spec.systemPrompt) args.push('--append-system-prompt', spec.systemPrompt);
  if (spec.model) args.push('--model', spec.model);
  const effort = parseEffort(spec.effort);
  if (effort) args.push('--thinking', effort);
  args.push(...piGrantArgs(spec, spec.toolGrant));
  return args;
}

/** pi's tool flags for each grant kind. No list keeps pi's own tool set, MCP and extension tools included. */
function piGrantArgs(spec: AgentRunSpec, grant: ToolGrant): string[] {
  switch (grant.kind) {
    case 'unset': return [];
    case 'step-default':
    case 'inherited': return piToolArgs(spec, grant.tools, grant.bashAllowlist);
    // A written copy of the default list takes the default path too, so no list keeps MCP and
    // extension tools out of a step that names only the default built-ins (hearsay-tools/cezarion#1417).
    case 'explicit': return piToolArgs(spec, grant.tools, grant.bashAllowlist);
    default: return unknownToolGrant(grant);
  }
}

// The built-ins Squawk's default list maps onto (DEFAULT_ALLOWED_TOOLS through piTools), and the
// names a default list may hold besides them (HARNESS_EXTRA_TOOLS.pi).
const PI_DEFAULT_BUILTINS = ['read', 'edit', 'write', 'grep', 'find', 'bash'];
const PI_DEFAULT_EXTRAS = ['subagent', 'subagent_supervisor', 'subagent_wait'];

/**
 * pi reads --tools as an allowlist that hides every tool it does not name, MCP and extension tools
 * included (hearsay-tools/cezarion#1305). So the default list sends no allowlist: --no-builtin-tools
 * keeps every tool registered and the default-tools extension activates the listed built-ins. The
 * default list holds every base built-in and nothing beyond pi's default set, so it covers both
 * pi's own step default and the six tools a worker inherits from a Claude parent. Any other name
 * (an mcp__ tool, WebFetch, a custom tool) or a bashAllowlist narrows the list to the allowlist, so
 * a step that grants named tools gets only those, and a list that maps to nothing fails closed.
 */
function piToolArgs(spec: AgentRunSpec, allowedTools: readonly string[], bashAllowlist: readonly string[] | undefined): string[] {
  const narrowedBash = (bashAllowlist?.length ?? 0) > 0;
  const tools = piTools(allowedTools, bashAllowlist);
  const isDefault = PI_DEFAULT_BUILTINS.every((tool) => tools.includes(tool))
    && tools.every((tool) => PI_DEFAULT_BUILTINS.includes(tool) || PI_DEFAULT_EXTRAS.includes(tool));
  if (!narrowedBash && isDefault) {
    // The Squawk tools need no name: pi activates an extension's tools on registration.
    return ['--no-builtin-tools', '--extension', piDefaultToolsExtensionPath(), '--cezar-builtin-tools', tools.join(',')];
  }
  if (spec.squawkTools) tools.push(...squawkToolNames(spec.env ?? {}));
  return tools.length > 0 ? ['--tools', tools.join(',')] : ['--no-tools'];
}

function piDegradedServiceRetryExtensionPath(): string {
  return fileURLToPath(new URL('../../scripts/pi-retry-degraded-service.mjs', import.meta.url));
}

function piProjectSkillsExtensionPath(): string {
  return fileURLToPath(new URL('../../scripts/pi-project-skills.mjs', import.meta.url));
}

function piDefaultToolsExtensionPath(): string {
  return fileURLToPath(new URL('../../scripts/pi-default-tools.mjs', import.meta.url));
}

function piTools(tools: readonly string[], bashAllowlist: readonly string[] | undefined): string[] {
  const map: Readonly<Record<string, string>> = {
    Read: 'read',
    Bash: 'bash',
    Edit: 'edit',
    Write: 'write',
    Grep: 'grep',
    Glob: 'find',
    Subagent: 'subagent',
    SubagentSupervisor: 'subagent_supervisor',
    SubagentWait: 'subagent_wait',
  };
  return [
    ...new Set(
      tools
        // Pi can allow/deny the whole bash tool but has no command-prefix
        // equivalent. Fail closed when a workflow requests that narrower mode.
        .filter((tool) => tool !== 'Bash' || !bashAllowlist || bashAllowlist.length === 0)
        .map((tool) => map[tool] ?? tool.toLowerCase()),
    ),
  ];
}

