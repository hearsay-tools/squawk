import { z } from '@hearsay-tools/squawk/plugin';
import type { AcpHooks } from '@hearsay-tools/squawk/plugin/acp';
import { AntigravitySubagentTracker, parseChildToolCallId } from './subagent-tracker.ts';
import { antigravityTool } from './tool-normalization.ts';

const textSchema = z.object({ text: z.string() });
/** The CLI writes an agent failure as one message chunk, "\n⚠ <error>\n" (CLI 1.5.14 format string
 *  `\n⚠ %s\n`). The error may or may not start "agent executor error:" (cli-config-options.ndjson,
 *  cli-tool-output.ndjson, the 404 of hearsay-tools/squawk#4098). */
const ERROR_SHAPE = /^\n⚠ \S[^]*\n$/u;

/** A chunk in the CLI's provider-failure shape. The turn fails only when this chunk is the whole
 *  agent message and no other agent work follows it before the turn ends (AcpEvents). */
export function antigravityUpdateError(update: Record<string, unknown>): string | undefined {
  const content = textSchema.safeParse(update.content);
  if (update.sessionUpdate !== 'agent_message_chunk' || !content.success) return undefined;
  return ERROR_SHAPE.test(content.data.text) ? content.data.text.trim() : undefined;
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
export function antigravityWireHooks(subagents: AntigravitySubagentTracker): AcpHooks {
  return {
    normalizeTool(update, previous) {
      const normalized = antigravityTool(update, previous);
      const id = typeof update.toolCallId === 'string' ? update.toolCallId : '';
      const child = parseChildToolCallId(id);
      if (child) {
        const parentItemId = subagents.parentForChild(child.childId) ?? previous?.parentItemId;
        if (parentItemId) normalized.parentItemId = parentItemId;
      }
      return normalized;
    },
    holdToolCompletion: (update, item) => subagents.shouldHold(update, item),
    afterToolUpdate: (update, item) => {
      subagents.observeStart(update, item);
      return subagents.afterToolUpdate(update, item);
    },
    settleOnTurnEnd: reason => subagents.settleOnTurnEnd(reason),
    updateError: antigravityUpdateError,
    agentWorkEnds: antigravityWorkEnds,
  };
}

export const ANTIGRAVITY_WIRE_HOOKS = antigravityWireHooks(new AntigravitySubagentTracker());
