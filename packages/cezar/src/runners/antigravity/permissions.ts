import { z } from 'zod';
import type { ToolGrant } from '../../core/agent-runner.ts';
import { unknownToolGrant } from '../../core/agent-runner-values.ts';
import type { AcpAsk, AcpAskRefusal, AcpPermissionOutcome, AcpPermissionRequest } from '../acp/protocol.ts';
import { antigravityTool, antigravityNativeToolName, antigravityMcpTool } from './tool-normalization.ts';

export function antigravityAsk(request: AcpPermissionRequest): AcpAsk | AcpAskRefusal | undefined {
  if (!request.toolCall.toolCallId.startsWith('interaction_')) return undefined;
  if (request.options.length < 2 || request.options.length > 4) return { refused: 'Antigravity question cancelled: requires two to four offered answers' };
  const used = new Set<string>();
  const choices = request.options.map(option => {
    let label = option.name.slice(0, 60);
    for (let index = 2; used.has(label); index++) {
      const suffix = ` (${index})`;
      label = `${option.name.slice(0, 60 - suffix.length)}${suffix}`;
    }
    used.add(label); return { label, option };
  });
  const options = choices.map(({ label }) => ({ label }));
  return {
    questions: [{ header: 'Question', question: (request.toolCall.title ?? 'Choose an option').slice(0, 400),
      options, allowFreeText: false }],
    answer(value) {
      const text = z.string().parse(value).trim().replace(/^Question:\s*/, '');
      const option = choices.find(choice => choice.label === text)?.option
        ?? request.options.find(option => option.optionId === text || option.name === text);
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
  const mcp = antigravityMcpTool(request.toolCall);
  const native = mcp ? `${mcp.server}_${mcp.tool}` : antigravityNativeToolName(request.toolCall);
  const name = mcp ? native : tool.name ?? native;
  const named = names === undefined || names.some(allowed => allowed === name || allowed === native || allowed.replace(/^mcp__/, '').replaceAll('__', '_') === native);
  const permitted = named && (!!mcp || tool.name !== 'Bash' || commandAllowed(tool.input, prefixes));
  // An unset grant leaves native approvals in control, as on the other adapters.
  if ((names === undefined && !prefixes.length) || (!permitted && approvalGate)) return undefined;
  return selected(request, permitted);
}
