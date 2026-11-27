/**
 * Agent Client Protocol (ACP v1) session, transport, event sink and protocol schemas
 * (`@hearsay-tools/squawk/plugin/acp`). Kept separate from `@hearsay-tools/squawk/plugin` so
 * non-ACP runners do not load the ACP session layer.
 * Unstable: it may change in any release until Squawk installs plugins from npm or git.
 */

export { initializeSchema, permissionSchema, recordSchema } from '../core/acp/protocol.ts';
export type {
  AcpAsk, AcpAskRefusal, AcpHooks, AcpInitializeResult, AcpPermissionOutcome, AcpPermissionRequest, AcpSettledTool,
} from '../core/acp/protocol.ts';
export { AcpRpcError, AcpTransport } from '../core/acp/transport.ts';
export type { RpcId } from '../core/acp/transport.ts';
export { AcpSession } from '../core/acp/session.ts';
export type { AcpOpenOptions, AcpSessionOptions } from '../core/acp/session.ts';
export { AcpEvents } from '../core/acp/events.ts';
export type { AcpEventSink } from '../core/acp/events.ts';
export { addUsage } from '../core/acp/usage.ts';
