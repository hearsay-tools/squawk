import { filterAntigravityUpdate, antigravityUpdateError } from './wire-updates.ts';
import { askPayloadOf } from '@open-mercato/cezar-contract/pending-ask';
import { rm } from 'node:fs/promises';
import { z } from 'zod';
import type { AgentEvent, AgentRunResult, AgentRunSpec, AgentSession, ContentBlock, SessionOptions } from '../../core/agent-runner.ts';
import { SessionEndedBeforeAcknowledgement } from '../../core/agent-runner-values.ts';
import { openingContent, validSkillMessage } from '../../core/skill-trigger.ts';
import { spawnSessionLeader, signalSession } from '../../core/session-process.ts';
import { SessionDescendants } from '../../core/session-descendants.ts';
import { AUTO_END_DELAY_MS, boundOutputDrainAfterExit, DEFAULT_RUNNER_TIMINGS } from '../../core/runner-runtime.ts';
import { AcpSession } from '../acp/session.ts';
import { antigravityEnv } from './runtime-env.ts';
import { antigravityMcp } from './http-mcp.ts';
import { antigravityTool } from './tool-normalization.ts';
import { antigravityAsk, permissionPolicy } from './permissions.ts';
import { squawkToolNames } from '../../ci-wait/tool-catalog.ts';
import { productEnv } from '../../core/product-env.ts';
import { antigravityReadFile } from './client-files.ts';
import { antigravityUsage } from './usage.ts';
import { summarizeRunnerStderr } from '../../core/runner-stderr.ts';
import { antigravityStderr } from './stderr.ts';
import { antigravityLaunchArgs } from './launch-args.ts';
import { logAntigravityFailure } from './native-diagnostics.ts';
import type { UiEvent } from '../../core/ui-events.ts';

const configSchema = z.array(z.object({ id: z.string(), category: z.string().optional() }).passthrough());
function contentBlocks(content: readonly ContentBlock[]): Record<string, unknown>[] {
  return content.filter(block => !(content[0]?.type === 'skill' && block.type === 'text' && !block.text)).map(block => {
    if (block.type === 'skill') return { type: 'text', text: `/${block.id}${block.args ? ` ${block.args}` : ''}` };
    if (block.type === 'image') return { type: 'image', data: block.source.data, mimeType: block.source.media_type };
    return block;
  });
}
/** Owns process lifetime. AcpSession owns wire parsing and outstanding native requests. */
export class AntigravitySession implements AgentSession {
  readonly result: Promise<AgentRunResult>;
  private readonly runtime;
  private readonly child;
  private readonly descendants;
  private readonly acp: AcpSession;
  private readonly exited: Promise<number | null>;
  private readonly output: AgentRunResult = { text: '', toolCalls: [], tokensUsed: 0 };
  private readonly stderr: string[] = [];
  private readonly queue: ContentBlock[][] = [];
  private bridge: Awaited<ReturnType<typeof antigravityMcp>>;
  private ready = false;
  private inflight = 0;
  private get busy(): boolean { return this.inflight > 0; }
  private providerError: string | undefined;
  private accepting = true;
  private requestedClose = false;
  private interrupted = false;
  private timedOut = false;
  private failure: Error | undefined;
  private pendingAsk: string | undefined;
  private humanAcks = 0;
  private agentAcks = 0;
  private reportedFailure = false;
  private failedTurn: Extract<UiEvent, { type: 'turn.completed' }> | undefined;
  private readonly humanHolds = new Set<symbol>();
  private readonly steers = new Map<symbol, boolean>();
  private configOptions: unknown;
  private autoEnd: NodeJS.Timeout | undefined;
  private term: NodeJS.Timeout | undefined;
  private kill: NodeJS.Timeout | undefined;
  private deadline: NodeJS.Timeout | undefined;
  private readonly limit: number;
  constructor(bin: string, private readonly spec: AgentRunSpec, private readonly onEvent: ((event: AgentEvent) => void) | undefined,
    private readonly options: SessionOptions, timeoutMs?: number) {
    this.runtime = antigravityEnv(bin, spec);
    this.child = spawnSessionLeader(bin, antigravityLaunchArgs(), { cwd: spec.cwd, env: this.runtime.env, scope: spec.scope, timings: spec.timings });
    this.descendants = new SessionDescendants(this.child);
    boundOutputDrainAfterExit(this.child);
    this.acp = this.createAcp();
    this.child.stderr.setEncoding('utf8'); this.child.stderr.on('data', (chunk: string) => this.stderr.push(chunk));
    this.child.on('error', error => { this.failure = new Error(`${error.message}. Install Antigravity ACP and put agy on PATH, or set HSQ_ANTIGRAVITY_BIN.`); this.acp.transport.close(error); });
    this.exited = new Promise(resolve => this.child.once('close', resolve));
    this.limit = spec.timeoutMs ?? timeoutMs ?? spec.timings?.runTimeoutMs ?? DEFAULT_RUNNER_TIMINGS.runTimeoutMs;
    if (this.limit > 0) this.deadline = setTimeout(() => { this.timedOut = true; this.emit({ type: 'error', message: `Antigravity timed out after ${this.limit}ms` }); this.interrupt(); }, this.limit);
    const boot = this.boot().catch(error => this.fail(error));
    this.result = this.settle(boot);
  }
  get pid(): number | undefined { return this.child.pid; }
  get open(): boolean { return this.accepting; }
  private emit(event: AgentEvent): void {
    if (event.type === 'turn-end' && this.failedTurn) return;
    if (event.type === 'text') this.output.text += event.text;
    if (event.type === 'tool-call') this.output.toolCalls.push({ id: event.id, name: event.tool, input: event.input });
    if (event.type === 'session') this.output.sessionId = event.sessionId;
    this.onEvent?.(event);
  }
  private createAcp(): AcpSession {
    const spec = this.spec;
    return new AcpSession({ input: this.child.stdin, output: this.child.stdout }, {
      backend: 'antigravity', clientInfo: { name: 'squawk', version: '1' }, // ACP usage_update reports context occupancy, not spent tokens.
      event: event => { if (event.type !== 'token-usage') this.emit(event); },
      onActivity: () => this.options.onActivity?.(),
      uiEvent: event => {
        if (event.type === 'turn.started' || event.type === 'turn.completed') {
          if (event.type === 'turn.completed') {
            for (const hold of this.humanHolds) if (!this.steers.has(hold)) this.humanHolds.delete(hold);
          }
          for (const [hold, acknowledged] of this.steers) {
            if (event.type === 'turn.started' || acknowledged) { this.humanHolds.delete(hold); this.steers.delete(hold); }
          }
        }
        if (event.type === 'turn.completed' && event.stopReason === 'error' && !this.reportedFailure) {
          this.failedTurn = event; return;
        }
        if (event.type === 'turn.completed' && event.usage) {
          this.output.tokensUsed += event.usage.total;
          this.emit({ type: 'token-usage', tokensUsed: this.output.tokensUsed });
        }
        const ask = askPayloadOf(event);
        if (ask) this.pendingAsk = ask.requestId;
        this.options.onUiEvent?.(event);
      }, hooks: {
        selectAuthMethod: hello => this.runtime.env.GEMINI_API_KEY && hello.authMethods.some(method => method.id === 'gemini-api-key') ? 'gemini-api-key' : undefined,
        normalizeTool: antigravityTool, normalizeUsage: antigravityUsage,
        normalizeOptions: value => { this.configOptions = value; },
        permissionAsk: antigravityAsk, permissionPolicy: request => permissionPolicy(spec.toolGrant, request, productEnv('APPROVAL_GATE', this.runtime.env) === '1', spec.squawkTools ? squawkToolNames(spec.env ?? {}).map(name => `${spec.squawkTools!.name}_${name}`) : []),
        readTextFile: params => antigravityReadFile(params, spec.cwd, spec.toolGrant),
        // agy sorts active workspaces to choose its command cwd. Extra roots can displace
        // the task checkout. Absolute handoff/temp paths remain available to shell tools.
        sessionParams: () => ({ _meta: { antigravity: { systemPrompt: { append: spec.systemPrompt ?? '' },
          // Squawk owns workflows. The native tool also writes a built-in skill into cwd.
          disabledTools: ['run_workflow'], eagerMcpServers: spec.squawkTools ? [spec.squawkTools.name] : [] } } }),
        filterUpdate: update => {
          const failure = antigravityUpdateError(update);
          this.providerError = failure ?? this.providerError;
          if (failure) this.reportFailure(failure);
          return filterAntigravityUpdate(update);
        },
        promptError: () => { const error = this.providerError; this.providerError = undefined; return error; },
      },
    });
  }
  private async boot(): Promise<void> {
    this.bridge = await antigravityMcp(this.spec, this.runtime.env);
    if (!this.open) return;
    await this.acp.initialize();
    await this.acp.open({ cwd: this.spec.cwd, ...(this.spec.resume && this.spec.sessionId ? { sessionId: this.spec.sessionId } : {}), mcpServers: this.bridge ? [this.bridge.descriptor] : [] });
    // A saved yolo mode must never bypass the permission policy on Continue.
    await this.acp.setConfigOption('mode', 'default');
    if (this.spec.model) await this.acp.setConfigOption('model', this.spec.model);
    if (this.spec.effort) {
      const option = configSchema.parse(this.configOptions).find(option => option.category === 'thought_level');
      const levels = z.array(z.object({ value: z.string() })).safeParse(option?.options);
      if (option && (!levels.success || levels.data.some(level => level.value === this.spec.effort))) await this.acp.setConfigOption(option.id, this.spec.effort);
      else this.emit({ type: 'note', message: `Antigravity model ${this.spec.model ?? '(default)'} ${option ? `does not offer effort ${this.spec.effort}` : 'has no effort setting'}; ignoring requested effort ${this.spec.effort}.` });
    }
    if (!this.open) return;
    this.ready = true;
    void this.submit(openingContent(this.spec, !!this.spec.resume)).catch(error => this.fail(error));
    this.options.onAgentInputReady?.();
  }
  private submit(content: ContentBlock[]): Promise<void> {
    this.clearAutoEnd();
    const steered = this.busy;
    this.inflight++;
    const operation = steered ? this.acp.steer(contentBlocks(content)) : this.acp.prompt(contentBlocks(content));
    return operation.then(() => {}).finally(() => {
      this.inflight--;
      if (this.busy) return;
      if (this.interrupted) this.closeInput();
      this.pendingAsk = undefined;
      if (this.open && this.queue.length) void this.submit(this.queue.shift()!).catch(error => this.fail(error));
      else if (this.open) { this.options.onAgentInputReady?.(); this.scheduleAutoEnd(); }
    });
  }
  sendMessage(content: ContentBlock[]): boolean {
    if (!this.open || !validSkillMessage(content)) return false;
    if (this.pendingAsk) return this.answerAsk(content);
    if (!this.ready) { this.queue.push(content); return true; }
    const steered = this.busy;
    const hold = Symbol('human input');
    this.humanHolds.add(hold); this.humanAcks++;
    if (steered) this.steers.set(hold, false);
    void this.submit(content).then(() => this.releaseHuman(hold, false), error => { this.releaseHuman(hold, true); this.fail(error); });
    return true;
  }
  private answerAsk(content: ContentBlock[]): boolean {
    try {
      const text = content.filter(block => block.type === 'text').map(block => block.text).join('\n');
      if (!this.acp.respondAsk(this.pendingAsk!, text)) return false;
      this.pendingAsk = undefined; return true;
    } catch (error) { this.emit({ type: 'note', message: String(error) }); return false; }
  }
  private releaseHuman(hold: symbol, rejected: boolean): void {
    this.humanAcks = Math.max(0, this.humanAcks - 1);
    if (rejected || !this.steers.has(hold)) this.humanHolds.delete(hold);
    else this.steers.set(hold, true);
    if (rejected) this.steers.delete(hold);
    this.options.onAgentInputReady?.();
    if (!this.busy) this.scheduleAutoEnd();
  }
  sendAgentMessage(content: ContentBlock[]): false | Promise<void> {
    if (!this.open || !this.ready || this.humanAcks || this.agentAcks || this.pendingAsk || !validSkillMessage(content)) return false;
    this.agentAcks++;
    return this.submit(content).catch(error => { if (!this.open && this.requestedClose) throw new SessionEndedBeforeAcknowledgement(); throw error; }).finally(() => {
      this.agentAcks--; this.options.onAgentInputReady?.(); if (!this.busy) this.scheduleAutoEnd();
    });
  }
  respondPermission(id: string, option: string): boolean { return this.acp.respondPermission(id, option); }
  discardQueuedMessages(): void { this.queue.length = 0; this.humanHolds.clear(); this.steers.clear(); }
  // Idle prompts release at their response. Early-acknowledged steers release at the
  // carrying turn completion; late steers release at successor turn.started. Rejection,
  // close and discard also release. ACP has no native consumption signal.
  holdsHumanInput(): boolean { return this.heldHumanInputCount() > 0; }
  heldHumanInputCount(): number { return this.queue.length + this.humanHolds.size; }
  end(): void {
    if (!this.open) return;
    this.beginClose(); this.closeInput();
    this.term = setTimeout(() => this.terminate(), this.spec.timings?.eofTermGraceMs ?? DEFAULT_RUNNER_TIMINGS.eofTermGraceMs);
  }
  private beginClose(): void {
    this.descendants.capture();
    this.requestedClose = true; this.accepting = false; this.clearAutoEnd(); this.discardQueuedMessages(); this.pendingAsk = undefined;
  }
  private closeInput(): void { this.acp.close(); this.child.stdin.end(); }
  private terminate(): void {
    this.descendants.terminate(this.spec.timings?.eofKillGraceMs ?? DEFAULT_RUNNER_TIMINGS.eofKillGraceMs);
    signalSession(this.child, 'SIGTERM');
    this.kill = setTimeout(() => signalSession(this.child, 'SIGKILL'), this.spec.timings?.eofKillGraceMs ?? DEFAULT_RUNNER_TIMINGS.eofKillGraceMs);
  }
  interrupt(): void {
    if (!this.open) return;
    this.interrupted = true; this.beginClose();
    if (this.ready && this.busy) {
      try { this.acp.cancel(); } catch { /* The shutdown deadline still owns cleanup. */ }
      // Leave the transport open for failed tool updates and the cancelled prompt response.
      this.term = setTimeout(() => { this.closeInput(); this.terminate(); }, this.spec.timings?.eofTermGraceMs ?? DEFAULT_RUNNER_TIMINGS.eofTermGraceMs);
    } else { this.closeInput(); this.terminate(); }
  }
  private fail(error: unknown): void {
    if (!this.open) return;
    this.failure ??= error instanceof Error ? error : new Error(String(error));
    this.end();
  }
  private clearAutoEnd(): void { clearTimeout(this.autoEnd); this.autoEnd = undefined; }
  private scheduleAutoEnd(): void {
    if (!this.open || !this.options.autoEndAfterFirstTurn || this.agentAcks || this.humanAcks || this.autoEnd) return;
    this.autoEnd = setTimeout(() => {
      this.autoEnd = undefined;
      if (this.open && !this.busy && !this.humanAcks && !this.queue.length && this.options.shouldAutoEnd?.() !== false) this.end();
    }, AUTO_END_DELAY_MS);
  }
  private reportFailure(message: string): void {
    if (this.reportedFailure) return;
    this.reportedFailure = true;
    this.emit({ type: 'error', message });
    this.options.onUiEvent?.({ type: 'session.error', message, fatal: true });
  }
  private async settle(boot: Promise<void>): Promise<AgentRunResult> {
    const code = await this.exited;
    this.accepting = false; this.acp.close(); this.clearAutoEnd(); clearTimeout(this.term); clearTimeout(this.kill); clearTimeout(this.deadline);
    this.descendants.terminate(this.spec.timings?.eofKillGraceMs ?? DEFAULT_RUNNER_TIMINGS.eofKillGraceMs);
    await boot;
    await this.bridge?.close();
    const unexpected = !this.requestedClose && (code !== 0 || this.busy);
    if (this.timedOut || this.failure || unexpected || this.reportedFailure) {
      await logAntigravityFailure(this.runtime.temp, 'session', this.failure ?? this.providerError ?? `Agent exited code ${code}`, this.runtime.env);
    }
    await rm(this.runtime.temp, { recursive: true, force: true });
    if (this.timedOut) throw new Error(`Antigravity timed out after ${this.limit}ms`);
    const stderr = antigravityStderr(this.stderr.join(''));
    if (this.failure || unexpected) {
      const message = [this.failure?.message, `Antigravity exited code ${code}`, summarizeRunnerStderr(stderr)].filter(Boolean).join(': ');
      const error = new Error(message);
      this.reportFailure(message);
      if (stderr) this.emit({ type: 'note', message: `Antigravity stderr:\n${stderr}` });
      if (this.failedTurn) {
        const turn = this.failedTurn; this.failedTurn = undefined;
        this.options.onUiEvent?.(turn); this.emit({ type: 'turn-end' });
      }
      throw error;
    }
    this.emit({ type: 'done' }); this.output.text = this.output.text.trim(); return this.output;
  }
}
