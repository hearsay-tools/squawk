import { z, type StopReason, type UiToolItem } from '@hearsay-tools/squawk/plugin';
import { antigravityNativeToolName } from './tool-normalization.ts';

const CHILD_CALL_PREFIX = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(.+)$/i;
const CONVERSATION_ID_FIELD = /"conversationId"\s*:\s*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/i;
const MESSAGE_SENDER = /\[Message\][^\n]*\bsender=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b[^\n]*\bcontent=([\s\S]*)$/i;
const manageArgsSchema = z.object({ Action: z.string().optional(), ConversationIds: z.array(z.string()).optional() }).passthrough();

export interface SettledSubagent {
  id: string;
  status: 'completed' | 'failed' | 'declined';
  output?: string | undefined;
}

/** Splits `<childConversationId>:<rawToolCallId>` forwarded by CLI 1.5.16+ ACP. */
export function parseChildToolCallId(toolCallId: string): { childId: string; rawCallId: string } | undefined {
  const match = CHILD_CALL_PREFIX.exec(toolCallId);
  return match ? { childId: match[1]!.toLowerCase(), rawCallId: match[2]! } : undefined;
}

/** Extracts the spawned subagent UUID from an `invoke_subagent` parent transcript row. */
export function parseSpawnedSubagentId(text: string): string | undefined {
  return CONVERSATION_ID_FIELD.exec(text)?.[1]?.toLowerCase();
}

/** Extracts the sender UUID and message body from a parent `SYSTEM_MESSAGE` delivery row. */
export function parseChildMessageDelivery(content: string): { childId: string; body: string } | undefined {
  const match = MESSAGE_SENDER.exec(content);
  if (!match) return undefined;
  const body = match[2]!.replace(/\r?\n<\/SYSTEM_MESSAGE>\s*$/, '').trim();
  return { childId: match[1]!.toLowerCase(), body };
}

/**
 * Tracks Antigravity native subagent spawns (`invoke_subagent`) and maps forwarded child tool calls
 * (`<childId>:<callId>`) to their parent task item. Forkable so the pure UI mapper and live session
 * execute the exact same state machine.
 */
export class AntigravitySubagentTracker {
  private activeCalls = new Set<string>();
  private unboundOrder: string[] = [];
  private childToParent = new Map<string, string>();
  private parentToChild = new Map<string, string>();
  private latestReply = new Map<string, string>();

  fork(): AntigravitySubagentTracker {
    const next = new AntigravitySubagentTracker();
    next.activeCalls = new Set(this.activeCalls);
    next.unboundOrder = [...this.unboundOrder];
    next.childToParent = new Map(this.childToParent);
    next.parentToChild = new Map(this.parentToChild);
    next.latestReply = new Map(this.latestReply);
    return next;
  }

  /** Explicitly links a spawned child conversation UUID to its parent `invoke_subagent` call ID. */
  bindChild(parentItemId: string, childId: string): void {
    const key = childId.toLowerCase();
    const previousParent = this.childToParent.get(key);
    if (previousParent && previousParent !== parentItemId) this.parentToChild.delete(previousParent);
    this.childToParent.set(key, parentItemId);
    this.parentToChild.set(parentItemId, key);
    this.unboundOrder = this.unboundOrder.filter(id => id !== parentItemId);
  }

  parentForChild(childId: string): string | undefined {
    const key = childId.toLowerCase();
    const existing = this.childToParent.get(key);
    if (existing) return existing;
    // Only auto-bind when a single unbound parent exists; parallel spawns wait for bindChild.
    if (this.unboundOrder.length !== 1) return undefined;
    const nextParent = this.unboundOrder.shift()!;
    this.childToParent.set(key, nextParent);
    this.parentToChild.set(nextParent, key);
    return nextParent;
  }

  childForParent(parentItemId: string): string | undefined {
    return this.parentToChild.get(parentItemId);
  }

  /** True when the tool is a root `invoke_subagent` whose spawn completed and child now runs in this turn. */
  shouldHold(update: Record<string, unknown>, item: UiToolItem): boolean {
    if (item.parentItemId !== undefined || antigravityNativeToolName(update) !== 'invoke_subagent') return false;
    if (item.status === 'failed' || item.status === 'declined') {
      this.activeCalls.delete(item.id);
      this.unboundOrder = this.unboundOrder.filter(id => id !== item.id);
      return false;
    }
    this.trackActive(item.id);
    return item.status === 'completed';
  }

  /** Observes a non-terminal `invoke_subagent` start so it is ready to bind children immediately. */
  observeStart(update: Record<string, unknown>, item: UiToolItem): void {
    if (item.parentItemId === undefined && antigravityNativeToolName(update) === 'invoke_subagent' && item.status !== 'failed' && item.status !== 'declined') {
      this.trackActive(item.id);
    }
  }

  /** Resolves subagents killed by a completed `manage_subagents` call. */
  afterToolUpdate(update: Record<string, unknown>, item: UiToolItem): SettledSubagent[] {
    if (item.parentItemId !== undefined || item.status !== 'completed' || antigravityNativeToolName(update) !== 'manage_subagents') return [];
    const args = manageArgsSchema.safeParse(update.rawInput ?? update.args).data;
    if (!args) return [];
    if (args.Action === 'kill_all') return this.drainActive('declined', 'Stopped by parent');
    if (args.Action !== 'kill' || !args.ConversationIds?.length) return [];
    const settled: SettledSubagent[] = [];
    for (const rawId of args.ConversationIds) {
      const parentId = this.childToParent.get(rawId.toLowerCase()) ?? (this.unboundOrder.length === 1 ? this.unboundOrder[0] : undefined);
      if (parentId && this.removeActive(parentId)) settled.push({ id: parentId, status: 'declined', output: 'Stopped by parent' });
    }
    return settled;
  }

  /** Records a child's `send_message` text without closing the subagent (it may keep working). */
  recordChildMessage(childId: string, output: string): string | undefined {
    const parentId = this.childToParent.get(childId.toLowerCase());
    if (!parentId || !this.activeCalls.has(parentId)) return undefined;
    if (output) this.latestReply.set(parentId, output);
    return parentId;
  }

  /** Settles every still-running `invoke_subagent` call when the parent turn finishes. */
  settleOnTurnEnd(reason: StopReason): SettledSubagent[] {
    const status = reason === 'cancelled' || reason === 'error' ? 'failed' : 'completed';
    return this.drainActive(status);
  }

  isActive(parentItemId: string): boolean { return this.activeCalls.has(parentItemId); }

  private trackActive(parentItemId: string): void {
    this.activeCalls.add(parentItemId);
    if (!this.parentToChild.has(parentItemId) && !this.unboundOrder.includes(parentItemId)) this.unboundOrder.push(parentItemId);
  }

  private removeActive(parentItemId: string): boolean {
    const existed = this.activeCalls.delete(parentItemId);
    this.unboundOrder = this.unboundOrder.filter(id => id !== parentItemId);
    this.latestReply.delete(parentItemId);
    return existed;
  }

  private drainActive(status: 'completed' | 'failed' | 'declined', output?: string): SettledSubagent[] {
    const ids = [...this.activeCalls];
    this.activeCalls.clear();
    this.unboundOrder = [];
    return ids.map(id => {
      const text = output ?? this.latestReply.get(id);
      this.latestReply.delete(id);
      return { id, status, ...(text ? { output: text } : {}) };
    });
  }
}
