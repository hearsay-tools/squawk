import { z } from 'zod';
import type { StopReason, TokenUsage, UiAskRequestedEvent, UiToolItem } from '../ui-events.ts';

export const recordSchema = z.record(z.string(), z.unknown());
export const initializeSchema = z.object({
  protocolVersion: z.literal(1), agentCapabilities: recordSchema.default({}),
  authMethods: z.array(z.object({ id: z.string(), name: z.string() }).passthrough()).default([]),
  agentInfo: z.object({ name: z.string(), version: z.string() }).passthrough().optional(),
}).passthrough();
export type AcpInitializeResult = z.infer<typeof initializeSchema>;
export const permissionSchema = z.object({
  sessionId: z.string(), toolCall: z.object({ toolCallId: z.string(), title: z.string().optional() }).passthrough(),
  options: z.array(z.object({ optionId: z.string(), name: z.string(),
    kind: z.enum(['allow_once', 'allow_always', 'reject_once', 'reject_always']),
  })).min(1),
}).passthrough();
export type AcpPermissionRequest = z.infer<typeof permissionSchema>;
export type AcpPermissionOutcome = { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' };
export interface AcpAsk {
  questions: UiAskRequestedEvent['questions'];
  /** ACP extensions encode answers differently. Only the runner knows that shape. */
  answer(value: unknown): unknown;
}
export interface AcpAskRefusal { refused: string }
export interface AcpSettledTool { id: string; status: 'completed' | 'failed' | 'declined'; output?: string | undefined }
export interface AcpHooks {
  /** Some ACP agents report execution failures as text followed by end_turn. A matching update
   *  makes the turn that carries it end as `error` when it opens a message of its own and no other
   *  agent work follows it before the turn ends; otherwise it stays plain text. */
  updateError?(update: Record<string, unknown>): string | undefined;
  /**
   * Agents whose idle session can wake on its own (a background command or timer ends) send work
   * with no prompt open. Providing this hook maps such work to an agent-started turn, which ends
   * when it returns true for an update (`previous` is the preceding work update's kind). Tools still
   * running when a prompt turn ends stay open and complete in a later turn.
   */
  agentWorkEnds?(update: Record<string, unknown>, previous: string | undefined): boolean;
  normalizeUsage?(usage: unknown): TokenUsage | undefined;
  /** Provider diagnostics or updates the adapter consumes itself. */
  filterUpdate?(update: Record<string, unknown>): boolean;
  selectAuthMethod?(hello: AcpInitializeResult): string | undefined;
  /** Return additional session/new, resume or load fields, including _meta. */
  sessionParams?(method: 'new' | 'resume' | 'load', params: Record<string, unknown>): Record<string, unknown>;
  normalizeTool?(update: Record<string, unknown>, previous: UiToolItem | undefined): Partial<Omit<UiToolItem, 'id' | 'kind'>>;
  /** Keep a tool item running past its immediate wire completion (e.g. an async subagent launcher). */
  holdToolCompletion?(update: Record<string, unknown>, item: UiToolItem): boolean;
  /** Optional held tools settled as a side-effect of another tool update (e.g. killing a subagent). */
  afterToolUpdate?(update: Record<string, unknown>, item: UiToolItem): readonly AcpSettledTool[];
  /** Held tools that settle when the current turn ends. */
  settleOnTurnEnd?(reason: StopReason): readonly AcpSettledTool[];
  normalizeOptions?(options: unknown): void;
  permissionPolicy?(request: AcpPermissionRequest): AcpPermissionOutcome | undefined;
  permissionAsk?(request: AcpPermissionRequest): AcpAsk | AcpAskRefusal | undefined;
  /** Only advertise filesystem reads when this callback is provided. */
  readTextFile?(params: unknown): Promise<{ content: string }>;
}
