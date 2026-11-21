import { z } from 'zod';
import type { TokenUsage, UiAskRequestedEvent, UiToolItem } from '../../core/ui-events.ts';

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
export interface AcpHooks {
  normalizeUsage?(usage: unknown): TokenUsage | undefined;
  /** Provider diagnostics or updates the adapter consumes itself. */
  filterUpdate?(update: Record<string, unknown>): boolean;
  selectAuthMethod?(hello: AcpInitializeResult): string | undefined;
  /** Return additional session/new, resume or load fields, including _meta. */
  sessionParams?(method: 'new' | 'resume' | 'load', params: Record<string, unknown>): Record<string, unknown>;
  normalizeTool?(update: Record<string, unknown>, previous: UiToolItem | undefined): Partial<Omit<UiToolItem, 'id' | 'kind'>>;
  normalizeOptions?(options: unknown): void;
  permissionPolicy?(request: AcpPermissionRequest): AcpPermissionOutcome | undefined;
  permissionAsk?(request: AcpPermissionRequest): AcpAsk | undefined;
  /** Only advertise filesystem reads when this callback is provided. */
  readTextFile?(params: unknown): Promise<{ content: string }>;
}
