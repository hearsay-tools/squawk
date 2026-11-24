import { z } from 'zod';
import type { ToolGrant } from '@hearsay-tools/squawk/plugin';
import { unknownToolGrant } from '@hearsay-tools/squawk/plugin/runtime';
import type { AcpPermissionOutcome, AcpPermissionRequest } from './acp/protocol.ts';
import { antigravityTool, antigravityNativeToolName, antigravityMcpTool } from './tool-normalization.ts';

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

/** Every process is returned to default mode before prompting: a saved mode must not bypass policy. */
export function permissionPolicy(grant: ToolGrant, request: AcpPermissionRequest, approvalGate = false, trustedNames: readonly string[] = []): AcpPermissionOutcome | undefined {
  const mcp = antigravityMcpTool(request.toolCall);
  if (mcp && trustedNames.includes(`${mcp.server}_${mcp.tool}`)) return selected(request, true);
  const tool = antigravityTool(request.toolCall);
  const names = allowedTools(grant);
  const prefixes = grant.bashAllowlist ?? [];
  const native = mcp ? `${mcp.server}_${mcp.tool}` : antigravityNativeToolName(request.toolCall);
  const name = mcp ? native : tool.name ?? native;
  const named = names === undefined || names.some(allowed => allowed === name || allowed === native || (!!mcp && allowed === `mcp__${mcp.server}__${mcp.tool}`));
  const permitted = named && (!!mcp || tool.name !== 'Bash' || commandAllowed(tool.input, prefixes));
  // An unset grant leaves native approvals in control, as on the other adapters.
  if ((names === undefined && !prefixes.length) || (!permitted && approvalGate)) return undefined;
  return selected(request, permitted);
}
