import { z } from 'zod';
import type { ToolGrant } from '../../core/agent-runner.ts';
import { unknownToolGrant } from '../../core/agent-runner-values.ts';
import type { AcpAsk, AcpPermissionOutcome, AcpPermissionRequest } from '../acp/protocol.ts';
import { antigravityTool } from './tool-normalization.ts';

export function antigravityAsk(request: AcpPermissionRequest): AcpAsk | undefined {
  if (!request.toolCall.toolCallId.startsWith('interaction_')) return undefined;
  const options = request.options.map(option => ({ label: option.name.slice(0, 60) }));
  return {
    questions: [{ header: 'Question', question: (request.toolCall.title ?? 'Choose an option').slice(0, 400),
      ...(options.length >= 2 && options.length <= 4 ? { options } : {}) }],
    answer(value) {
      const text = z.string().parse(value).trim().replace(/^Question:\s*/, '');
      const option = request.options.find(option => option.optionId === text || option.name === text);
      if (!option) throw new Error('Antigravity requires one of the offered answers');
      return { outcome: { outcome: 'selected', optionId: option.optionId } };
    },
  };
}

function allowedTools(grant: ToolGrant): readonly string[] | undefined {
  switch (grant.kind) {
    case 'unset': return undefined;
    case 'explicit': case 'inherited': case 'step-default': return grant.tools;
    default: return unknownToolGrant(grant);
  }
}

function selected(request: AcpPermissionRequest, permitted: boolean): AcpPermissionOutcome {
  const option = request.options.find(option => option.kind === (permitted ? 'allow_once' : 'reject_once'));
  return option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' };
}
function commandAllowed(input: unknown, prefixes: readonly string[]): boolean {
  if (!prefixes.length) return true;
  const parsed = z.object({ command: z.string() }).safeParse(input);
  if (!parsed.success || /[;&|`$<>\\\n\r]/.test(parsed.data.command)) return false;
  return prefixes.some(prefix => parsed.data.command === prefix || parsed.data.command.startsWith(`${prefix} `));
}

/** Every process is returned to default mode before prompting: saved yolo must not bypass policy. */
export function permissionPolicy(grant: ToolGrant, request: AcpPermissionRequest, approvalGate = false, trustedNames: readonly string[] = []): AcpPermissionOutcome | undefined {
  if (request.toolCall.toolCallId.startsWith('interaction_')) return undefined;
  if (trustedNames.includes(request.toolCall.title ?? '')) return selected(request, true);
  const tool = antigravityTool(request.toolCall);
  const names = allowedTools(grant);
  const prefixes = grant.bashAllowlist ?? [];
  const name = tool.name ?? request.toolCall.title ?? '';
  const named = names === undefined || names.some(allowed => allowed === name || allowed.replace(/^mcp__/, '').replaceAll('__', '_') === name);
  const permitted = named && (tool.name !== 'Bash' || commandAllowed(tool.input, prefixes));
  // An unset grant leaves native approvals in control, as on the other adapters.
  if ((names === undefined && !prefixes.length) || (!permitted && approvalGate)) return undefined;
  return selected(request, permitted);
}
