import { z } from 'zod';
import type { AcpHooks } from '../acp/protocol.ts';
import { antigravityTool } from './tool-normalization.ts';

const textSchema = z.object({ text: z.string() });
const ERROR_PREFIX = '⚠ agent executor error:';

/** The CLI reports a provider failure as message text, then end_turn (cli-config-options.ndjson). */
export function antigravityUpdateError(update: Record<string, unknown>): string | undefined {
  const content = textSchema.safeParse(update.content);
  if (update.sessionUpdate !== 'agent_message_chunk' || !content.success) return undefined;
  const text = content.data.text.trimStart();
  return text.startsWith(ERROR_PREFIX) ? text : undefined;
}

/**
 * Work after the turn (a background command or timer woke the idle session) has no end frame. A
 * usage update right after message text ends every agent step that carries no further tool call;
 * after thoughts or a tool it starts the next step (every cli-*.ndjson fixture).
 */
export function antigravityWorkEnds(update: Record<string, unknown>, previous: string | undefined): boolean {
  return update.sessionUpdate === 'usage_update' && previous === 'agent_message_chunk';
}

/** The ACP hooks that map Antigravity frames, shared by the live session and the fixture mapper. */
export const ANTIGRAVITY_WIRE_HOOKS = {
  normalizeTool: antigravityTool, updateError: antigravityUpdateError, agentWorkEnds: antigravityWorkEnds,
} as const satisfies AcpHooks;
