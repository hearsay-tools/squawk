import { randomUUID } from 'node:crypto';
import type { AgentSession, ContentBlock } from '../../core/agent-runner.ts';
import { RUNNER_FACTS } from '../../core/runner-facts.ts';
import type { QueuedMessage, RunRecord } from '../../runs/store.ts';
import type { ActiveRun } from '../active-run.ts';
import { contentBlocksOf, type PastedContent, type PersistedAttachment } from '../pasted-content.ts';
import type { AttachmentWriter } from './attachment-writer.ts';
import { atLiveInput } from './launch-read-resolver.ts';
import { leadingSlashSkillName } from './prompts.ts';
import type { RunLine } from './run-line.ts';
import type { RunMemory } from './run-memory.ts';
import type { RunSkills } from './run-skills.ts';
import type { RunModuleContext } from './types.ts';

export type NativeInput = { session: AgentSession; content: PastedContent[]; messageId: string; persisted: PersistedAttachment[] };
export type NativeInputRead = { state: ActiveRun; entry: NativeInput; ready: boolean };
type NativeInputResult = 'sent' | 'held' | 'refused' | 'stale';

interface NativeSkillInputHost {
  active: ReadonlyMap<string, ActiveRun>;
  attachments: AttachmentWriter;
  runSkills: RunSkills;
  line: RunLine;
  canProceedWithRun(id: string, run: RunRecord | undefined): boolean;
  questionPending(id: string, state: ActiveRun): boolean;
  parkForUser(id: string, state: ActiveRun, step: string | undefined): void;
  authorizeHumanMessage(id: string): boolean;
  recordHumanMessage(id: string, state: ActiveRun, content: PastedContent[], persisted: PersistedAttachment[]): void;
  latchAgentInputError(id: string, state: ActiveRun, session: AgentSession, message: string): void;
  deliverMessage(id: string, content: PastedContent[], messageId: string, blocks: ContentBlock[], persisted: PersistedAttachment[]): boolean;
  handleAgentInputReady(id: string, state: ActiveRun, session: AgentSession): void;
}

/** Resolve native triggers in FIFO order without letting an old session read reach its replacement. */
export class NativeSkillInputQueue {
  constructor(private readonly context: RunModuleContext, private readonly host: NativeSkillInputHost,
    private readonly memory: RunMemory) {}

  handles(runId: string, content: PastedContent[]): boolean {
    const first = content.find(block => block.type === 'text');
    return !!this.memory.read(runId, 'nativeSkillInputs')?.length ||
      !!atLiveInput.queuedMessages(this.context.store.getRun(runId))?.some(message => message.replayAfterOpen) ||
      !!(first?.type === 'text' && leadingSlashSkillName(first.text));
  }

  /** Accepted human input owns the next delivery until it reaches its transport. */
  pending(runId: string): boolean {
    return !!this.memory.read(runId, 'nativeSkillInputs')?.length ||
      !!atLiveInput.queuedMessages(this.context.store.getRun(runId))?.some(message => message.replayAfterOpen);
  }

  /** Readiness during a synchronous send belongs to that read until it finishes. */
  markReady(runId: string, state: ActiveRun, session: AgentSession): boolean {
    const read = this.memory.read(runId, 'nativeSkillRead');
    if (read?.state !== state || read.entry.session !== session) return false;
    read.ready = true;
    return true;
  }

  /** A held trigger stays durable and is resolved only when it can reach the transport. */
  enqueue(runId: string, content: PastedContent[], messageId?: string): boolean {
    const state = this.host.active.get(runId);
    const session = state?.liveSession.session;
    const run = this.context.store.getRun(runId);
    if (this.context.disposed() || !state || !session?.open || state.liveSession.cancelled || state.liveSession.finishRequested || state.liveSession.pendingPermissions?.size || !this.host.canProceedWithRun(runId, run)) return false;
    const id = messageId ?? randomUUID();
    const queued = atLiveInput.queuedMessages(this.context.store.getRun(runId)) ?? [];
    const pending = this.restorePending(runId, session, queued);
    if (pending.some(entry => entry.messageId === id)) { this.release(runId, state); return true; }
    if (!this.host.authorizeHumanMessage(runId)) return false;
    const snapshot = structuredClone(content);
    const persisted = this.host.attachments.persistPastedAttachments(runId, snapshot);
    this.host.recordHumanMessage(runId, state, snapshot, persisted);
    const existing = queued.find(message => message.id === id);
    const message: QueuedMessage = existing ? { ...existing, replayAfterOpen: true } : {
      id, text: snapshot.filter(block => block.type === 'text').map(block => block.text).join('\n'),
      images: persisted.map(file => file.url), createdAt: new Date().toISOString(), replayAfterOpen: true,
    };
    this.context.store.updateRun(runId, { queuedMessages: existing
      ? queued.map(entry => entry.id === id ? message : entry) : [...queued, message] });
    this.context.store.flush();
    pending.push({ session, content: snapshot, messageId: id, persisted });
    this.memory.write(runId, 'nativeSkillInputs', pending);
    this.release(runId, state);
    return true;
  }

  /** Restore before accepting later live input, including the session-open → deferred-flush gap. */
  private restorePending(runId: string, session: AgentSession, queued: QueuedMessage[]): NativeInput[] {
    const current = this.memory.read(runId, 'nativeSkillInputs');
    if (current?.length && current.every(entry => entry.session === session)) return current;
    const restored = queued.filter(message => message.replayAfterOpen).map(message => {
      const persisted = atLiveInput.attachments(this.context, runId, message.images ?? [], 'queued');
      return { session, messageId: message.id, content: [{ type: 'text' as const, text: message.text }, ...persisted.blocks],
        persisted: persisted.attachments };
    });
    this.memory.write(runId, 'nativeSkillInputs', restored.length ? restored : undefined);
    return restored;
  }

  private holdsNativeSkill(state: ActiveRun, content: PastedContent[]): boolean {
    const query = state.skills.query;
    if (!query || RUNNER_FACTS[query.runner].skillTriggerMidTurn) return false;
    const first = content.find(block => block.type === 'text');
    const id = first?.type === 'text' ? leadingSlashSkillName(first.text) : undefined;
    return !!id && this.host.runSkills.enabledSkills(state).some(skill => skill.id === id) && state.boundary.atTurnBoundary !== state.liveSession.session;
  }

  /** Returning true keeps turn settlement behind the accepted human input. */
  release(runId: string, state: ActiveRun): boolean {
    const pending = this.memory.read(runId, 'nativeSkillInputs');
    const entry = pending?.[0];
    if (!entry || !this.nativeInputCurrent(runId, state, entry) || state.inputState.agentInputError || state.liveSession.agentSessionError) return false;
    // Surface the turn's question before starting any held follow-up.
    if (this.host.questionPending(runId, state)) return false;
    if (this.memory.read(runId, 'nativeSkillRead') || this.holdsNativeSkill(state, entry.content)) return true;
    const read = { state, entry, ready: false };
    this.memory.write(runId, 'nativeSkillRead', read);
    const work = this.sendNativeInput(runId, state, entry)
      .then(result => this.finishNativeRead(runId, read, result))
      .catch(error => {
        if (this.nativeInputCurrent(runId, state, entry)) this.host.latchAgentInputError(runId, state, entry.session,
          `human skill input failed: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => { if (this.memory.read(runId, 'nativeSkillRead') === read) this.memory.write(runId, 'nativeSkillRead', undefined); });
    void this.context.work.track('nativeSkillInput', work);
    return true;
  }

  private nativeInputCurrent(runId: string, state: ActiveRun, entry: NativeInput): boolean {
    return !this.context.disposed() && this.host.active.get(runId) === state && state.liveSession.session === entry.session &&
      entry.session.open && !state.liveSession.cancelled && !state.liveSession.finishRequested && this.memory.read(runId, 'nativeSkillInputs')?.[0] === entry;
  }

  private async sendNativeInput(runId: string, state: ActiveRun, entry: NativeInput): Promise<NativeInputResult> {
    const blocks = await this.host.runSkills.nativeInput(runId, state, contentBlocksOf(entry.content));
    if (!this.nativeInputCurrent(runId, state, entry)) return 'stale';
    // A live-list runner may discover a name that was absent at enqueue time.
    if (this.host.questionPending(runId, state)) return 'held';
    if (blocks[0]?.type === 'skill' && this.nativeTriggerBusy(state)) return 'held';
    return this.host.deliverMessage(runId, entry.content, entry.messageId, blocks, entry.persisted) ? 'sent' : 'refused';
  }

  private finishNativeRead(runId: string, read: NativeInputRead, result: NativeInputResult): void {
    if (this.memory.read(runId, 'nativeSkillRead') !== read) return;
    this.memory.write(runId, 'nativeSkillRead', undefined);
    const { state, entry } = read;
    if (!this.nativeInputCurrent(runId, state, entry)) return;
    if (result === 'sent') {
      const pending = this.memory.read(runId, 'nativeSkillInputs')!;
      pending.shift();
      if (!pending.length) this.memory.write(runId, 'nativeSkillInputs', undefined);
      if (pending.length) this.release(runId, state);
      if (read.ready) this.host.handleAgentInputReady(runId, state, entry.session);
      return;
    }
    // A refused transport may become ready later. Keep the durable message, release the slot,
    // and let its readiness callback retry; retrying from this promise would spin without input.
    if (result === 'refused' && state.boundary.atTurnBoundary === entry.session && !this.host.line.isParked(runId)) {
      this.host.parkForUser(runId, state, state.liveSession.currentStepId);
    }
  }

  clear(runId: string): void { this.memory.write(runId, 'nativeSkillInputs', undefined); this.memory.write(runId, 'nativeSkillRead', undefined); }

  private nativeTriggerBusy(state: ActiveRun): boolean {
    const runner = state.skills.query?.runner;
    return !!runner && !RUNNER_FACTS[runner].skillTriggerMidTurn && state.boundary.atTurnBoundary !== state.liveSession.session;
  }
}
