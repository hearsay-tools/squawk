import { rm } from 'node:fs/promises';
import { z } from 'zod';
import type { AgentEvent, AgentRunResult, AgentRunSpec, AgentSession, ContentBlock, SessionOptions } from '../../core/agent-runner.ts';
import { prependSystemPrompt, SessionEndedBeforeAcknowledgement } from '../../core/agent-runner-values.ts';
import { openingContent, validSkillMessage } from '../../core/skill-trigger.ts';
import { spawnSessionLeader, signalSession } from '../../core/session-process.ts';
import { SessionDescendants } from '../../core/session-descendants.ts';
import { AUTO_END_DELAY_MS, boundOutputDrainAfterExit, DEFAULT_RUNNER_TIMINGS } from '../../core/runner-runtime.ts';
import { AcpSession } from '../acp/session.ts';
import { AcpRpcError } from '../acp/transport.ts';
import { antigravityEnv } from './runtime-env.ts';
import { antigravityMcp } from './http-mcp.ts';
import { ANTIGRAVITY_MCP_NAME } from './mcp-name.ts';
import { permissionPolicy } from './permissions.ts';
import { squawkToolNames } from '../../ci-wait/tool-catalog.ts';
import { productEnv } from '../../core/product-env.ts';
import { antigravityReadFile } from './client-files.ts';
import { antigravityUsage } from './usage.ts';
import { summarizeRunnerStderr } from '../../core/runner-stderr.ts';
import { antigravityLaunchArgs } from './launch-args.ts';
import { logAntigravityFailure, redactAntigravityDiagnostics } from './native-diagnostics.ts';
import { ANTIGRAVITY_WIRE_HOOKS, antigravityUpdateError } from './wire-updates.ts';
import { ANTIGRAVITY_MISSING, launchAntigravity, missingAntigravity, type AntigravityLaunch } from './executable.ts';
import { antigravityQuestion, antigravityAnswer } from './ask-question.ts';
import type { UiAskQuestion, UiEvent } from '../../core/ui-events.ts';

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
  private readonly launch: AntigravityLaunch;
  private readonly child;
  private readonly descendants;
  private readonly acp: AcpSession;
  private readonly exited: Promise<number | null>;
  private readonly output: AgentRunResult = { text: '', toolCalls: [], tokensUsed: 0 };
  private stderr = '';
  private readonly queue: ContentBlock[][] = [];
  private bridge: Awaited<ReturnType<typeof antigravityMcp>>;
  private ready = false;
  /** session/resume failed and a fresh session continues the task. */
  private lostSession = false;
  private inflight = 0;
  private get busy(): boolean { return this.inflight > 0; }
  private providerError: string | undefined;
  private accepting = true;
  private requestedClose = false;
  private quiet = false;
  private quietTimer: NodeJS.Timeout | undefined;
  private interrupted = false;
  private timedOut = false;
  private failure: Error | undefined;
  /** The open ask_question call: its card's request id and question. The next prompt answers it. */
  private pendingAsk: { requestId: string; toolCallId: string; question: UiAskQuestion } | undefined;
  private humanAcks = 0;
  private agentAcks = 0;
  private reportedFailure = false;
  private failedTurn: Extract<UiEvent, { type: 'turn.completed' }> | undefined;
  private readonly humanHolds = new Set<symbol>();
  private configOptions: unknown;
  private autoEnd: NodeJS.Timeout | undefined;
  private term: NodeJS.Timeout | undefined;
  private kill: NodeJS.Timeout | undefined;
  private deadline: NodeJS.Timeout | undefined;
  private readonly limit: number;
  constructor(bin: string | undefined, private readonly spec: AgentRunSpec, private readonly onEvent: ((event: AgentEvent) => void) | undefined,
    private readonly options: SessionOptions, timeoutMs?: number) {
    this.runtime = antigravityEnv(spec);
    this.launch = launchAntigravity(bin) ?? missingAntigravity(this.runtime.temp);
    this.child = spawnSessionLeader(this.launch.executable, antigravityLaunchArgs(this.runtime.geminiDir), { cwd: spec.cwd, env: this.runtime.env, scope: spec.scope, timings: spec.timings });
    try { if (this.child.pid) this.launch.bindProcess(this.child.pid); }
    catch (error) { this.failure = error instanceof Error ? error : new Error(String(error)); }
    this.descendants = new SessionDescendants(this.child);
    boundOutputDrainAfterExit(this.child);
    this.acp = this.createAcp();
    this.child.stderr.setEncoding('utf8'); this.child.stderr.on('data', (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-32_768); });
    this.child.on('error', error => {
      this.failure = new Error((error as NodeJS.ErrnoException).code === 'ENOENT' ? ANTIGRAVITY_MISSING : error.message);
      this.acp.transport.close(error);
    });
    this.exited = new Promise(resolve => this.child.once('close', resolve));
    this.limit = spec.timeoutMs ?? timeoutMs ?? spec.timings?.runTimeoutMs ?? DEFAULT_RUNNER_TIMINGS.runTimeoutMs;
    if (this.limit > 0) this.deadline = setTimeout(() => { this.timedOut = true; this.emit({ type: 'error', message: `Antigravity timed out after ${this.limit}ms` }); this.interrupt(); }, this.limit);
    const boot = this.failure ? Promise.resolve().then(() => this.fail(this.failure)) : this.boot().catch(error => this.fail(error));
    this.result = this.settle(boot);
  }
  get pid(): number | undefined { return this.child.pid; }
  get open(): boolean { return this.accepting; }
  get closingQuietly(): boolean { return this.quiet && !this.requestedClose; }
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
      uiEvent: event => this.uiEvent(event),
      hooks: {
        ...ANTIGRAVITY_WIRE_HOOKS,
        selectAuthMethod: hello => this.runtime.env.GEMINI_API_KEY && hello.authMethods.some(method => method.id === 'gemini-api-key') ? 'gemini-api-key' : undefined,
        normalizeUsage: antigravityUsage,
        normalizeOptions: value => { this.configOptions = value; },
        permissionPolicy: request => permissionPolicy(spec.toolGrant, request, productEnv('APPROVAL_GATE', this.runtime.env) === '1', spec.squawkTools ? squawkToolNames(spec.env ?? {}).map(name => `${ANTIGRAVITY_MCP_NAME}_${name}`) : []),
        readTextFile: params => antigravityReadFile(params, spec.cwd, spec.toolGrant),
        // The CLI saves the session/new system prompt with the session and appends a resent one,
        // so a resume prepends it to the opening turn instead (systemPromptOnResume 'in-thread').
        sessionParams: method => method === 'new' ? { _meta: { antigravity: { systemPrompt: { append: (this.lostSession ? spec.resumeFallbackSystemPrompt : undefined) ?? spec.systemPrompt ?? '' } } } } : {},
        filterUpdate: update => {
          const failure = antigravityUpdateError(update);
          this.providerError = failure ?? this.providerError;
          if (failure) this.reportFailure(failure);
          return true;
        },
      },
    });
  }
  private uiEvent(event: UiEvent): void {
    if (event.type === 'turn.started') { clearTimeout(this.quietTimer); this.clearAutoEnd(); }
    // The response that ends a turn carries every prompt sent into it: none is held after it.
    if (event.type === 'turn.completed') this.humanHolds.clear();
    if (event.type === 'turn.completed' && event.stopReason === 'error' && !this.reportedFailure) {
      this.failedTurn = event; return;
    }
    if (event.type === 'turn.completed' && event.usage) {
      this.output.tokensUsed += event.usage.total;
      this.emit({ type: 'token-usage', tokensUsed: this.output.tokensUsed });
    }
    this.options.onUiEvent?.(event);
    if (event.type === 'item.started' && event.item.kind === 'tool' && event.item.name === 'ask_question') this.openAsk(event.item.id, event.item.input);
    if (event.type === 'item.completed' && event.item.id === this.pendingAsk?.toolCallId) this.pendingAsk = undefined;
    // Work the agent started on its own ended: input and auto-end resume as after a prompt.
    if (event.type === 'turn.completed' && !this.busy) {
      this.armQuietEnd();
      if (this.open) { this.options.onAgentInputReady?.(); this.scheduleAutoEnd(); }
    }
  }
  /** ask_question ends the prompt with the question as text; the next prompt is the answer. */
  private openAsk(toolCallId: string, input: unknown): void {
    const question = antigravityQuestion(input);
    if (!question) return;
    const ask = { requestId: `antigravity-ask-${toolCallId}`, toolCallId, question };
    this.pendingAsk = ask;
    this.options.onUiEvent?.({ type: 'ask.requested', requestId: ask.requestId, questions: [question] });
  }
  private async boot(): Promise<void> {
    this.bridge = await antigravityMcp(this.spec, this.runtime.env);
    if (!this.open) return;
    await this.acp.initialize();
    await this.openSession(this.bridge ? [this.bridge.descriptor] : []);
    // A saved accept-edits or plan mode must never bypass the permission policy on Continue.
    await this.acp.setConfigOption('mode', 'default');
    if (this.spec.model) await this.acp.setConfigOption('model', this.spec.model);
    if (this.spec.effort) {
      const option = configSchema.parse(this.configOptions).find(option => option.category === 'thought_level');
      const levels = z.array(z.object({ value: z.string() })).safeParse(option?.options);
      if (option && (!levels.success || levels.data.some(level => level.value === this.spec.effort))) await this.acp.setConfigOption(option.id, this.spec.effort);
      else this.emit({ type: 'note', message: `Antigravity model ${this.spec.model ?? '(default)'} ${option ? `does not offer effort ${this.spec.effort}` : 'has no effort setting'}; ignoring requested effort ${this.spec.effort}.` });
    }
    if (!this.open) return;
    // The CLI runs read_file with no permission request, so the policy cannot withhold reads.
    const grant = this.spec.toolGrant;
    if (grant.kind !== 'unset' && !grant.tools.includes('Read')) this.emit({ type: 'note', message: 'Antigravity reads files without asking for permission; this step\'s tool grant does not include Read, but it cannot stop native file reads.' });
    this.ready = true;
    void this.submit(this.opening()).catch(error => this.fail(error));
    this.options.onAgentInputReady?.();
  }
  /** A session the CLI cannot reopen (one the retired registry server saved, or a removed
   *  conversation) continues in a fresh session, with the full system prompt and the skill. */
  private async openSession(mcpServers: Record<string, unknown>[]): Promise<void> {
    const sessionId = this.spec.resume ? this.spec.sessionId : undefined;
    if (!sessionId) { await this.acp.open({ cwd: this.spec.cwd, mcpServers }); return; }
    try { await this.acp.open({ cwd: this.spec.cwd, sessionId, mcpServers }); }
    catch (error) {
      if (!(error instanceof AcpRpcError)) throw error;
      this.lostSession = true;
      this.emit({ type: 'note', message: `Antigravity could not resume session ${sessionId} (${error.message}); continuing in a new session.` });
      await this.acp.open({ cwd: this.spec.cwd, mcpServers });
    }
  }
  /** `onAcknowledged` runs when the CLI takes the input: a steer when the running prompt answers
   *  for it, any prompt at its own response. */
  /** A resumed session carries spec.systemPrompt in its opening turn, as the other in-thread
   *  runners do: the CLI keeps the session/new prompt, and a resent _meta prompt would be appended. */
  private opening(): ContentBlock[] {
    const resumed = !!this.spec.resume && !this.lostSession;
    const content = openingContent(this.spec, resumed);
    if (!(resumed && this.spec.sessionId && this.spec.systemPrompt)) return content;
    const last = content.at(-1);
    if (last?.type !== 'text') return content;
    return [...content.slice(0, -1), { ...last, text: prependSystemPrompt(this.spec.systemPrompt, last.text) }];
  }
  private submit(content: ContentBlock[], onAcknowledged?: () => void): Promise<void> {
    this.clearAutoEnd();
    // The ACP prompt state decides, not `busy`: a turn's response closes the prompt before the
    // submission that carried it settles here, and input sent at that turn end opens a new one.
    const steered = this.acp.promptOpen;
    this.inflight++;
    const operation = steered ? this.acp.steer(contentBlocks(content), onAcknowledged) : this.acp.prompt(contentBlocks(content));
    return operation.then(() => { onAcknowledged?.(); }).finally(() => {
      this.inflight--;
      if (this.busy) return;
      if (this.interrupted) this.closeInput();
      if (this.open && this.queue.length) void this.submit(this.queue.shift()!).catch(error => this.fail(error));
      else if (this.open) { this.options.onAgentInputReady?.(); this.scheduleAutoEnd(); }
      this.armQuietEnd();
    });
  }
  sendMessage(content: ContentBlock[]): boolean {
    if (!this.open || !validSkillMessage(content)) return false;
    if (this.pendingAsk) content = this.answerAsk(content);
    if (!this.ready) { this.queue.push(content); return true; }
    const hold = Symbol('human input');
    this.humanHolds.add(hold); this.humanAcks++;
    let released = false;
    const release = () => { if (!released) { released = true; this.releaseHuman(hold); } };
    void this.submit(content, release).then(release, error => { release(); this.fail(error); });
    return true;
  }
  /** The card's answer becomes the next prompt, in the words the CLI's own question offered. */
  private answerAsk(content: ContentBlock[]): ContentBlock[] {
    const ask = this.pendingAsk!;
    this.pendingAsk = undefined;
    const text = content.filter(block => block.type === 'text').map(block => block.text).join('\n');
    return [{ type: 'text', text: antigravityAnswer(ask.question, text) }];
  }
  private releaseHuman(hold: symbol): void {
    this.humanAcks = Math.max(0, this.humanAcks - 1);
    this.humanHolds.delete(hold);
    this.options.onAgentInputReady?.();
    if (!this.busy) this.scheduleAutoEnd();
  }
  sendAgentMessage(content: ContentBlock[]): false | Promise<void> {
    if (!this.open || !this.ready || this.humanAcks || this.agentAcks || this.pendingAsk || !validSkillMessage(content)) return false;
    this.agentAcks++;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (error?: unknown) => {
        if (settled) { if (error !== undefined) this.fail(error); return; }
        settled = true;
        this.agentAcks--; this.options.onAgentInputReady?.(); if (!this.busy) this.scheduleAutoEnd();
        if (error === undefined) resolve();
        else reject(!this.open && this.requestedClose ? new SessionEndedBeforeAcknowledgement() : error);
      };
      this.submit(content, () => settle()).then(() => settle(), error => settle(error ?? new Error('Antigravity input failed')));
    });
  }
  respondPermission(id: string, option: string): boolean { return this.acp.respondPermission(id, option); }
  discardQueuedMessages(): void { this.queue.length = 0; this.humanHolds.clear(); }
  // A prompt is held from sendMessage until the turn it opens starts, or until its response: a
  // steered prompt's response ends the turn that read it. ACP has no consumption signal.
  // Rejection, close and discard also release.
  holdsHumanInput(): boolean { return this.heldHumanInputCount() > 0; }
  heldHumanInputCount(): number { return this.queue.length + this.humanHolds.size; }
  /** A background command or timer can wake the idle session and ask after a done: stay up
   *  AUTO_END_DELAY_MS for that, and end once no turn it opened still runs. */
  endWhenQuiet(): void {
    if (!this.open) return;
    this.quiet = true; this.accepting = false;
    this.clearAutoEnd(); this.discardQueuedMessages(); this.pendingAsk = undefined;
    this.armQuietEnd();
  }
  private armQuietEnd(): void {
    if (!this.quiet || this.requestedClose) return;
    clearTimeout(this.quietTimer);
    if (this.busy || this.acp.agentWorking) return;
    this.quietTimer = setTimeout(() => { if (!this.busy && !this.acp.agentWorking) this.end(); }, AUTO_END_DELAY_MS);
  }
  end(): void {
    if (this.requestedClose) return;
    this.beginClose(); this.closeInput();
    this.term = setTimeout(() => this.terminate(), this.spec.timings?.eofTermGraceMs ?? DEFAULT_RUNNER_TIMINGS.eofTermGraceMs);
  }
  private beginClose(): void {
    this.descendants.capture();
    this.requestedClose = true; this.accepting = false; this.clearAutoEnd(); clearTimeout(this.quietTimer); this.discardQueuedMessages(); this.pendingAsk = undefined;
  }
  private closeInput(): void { this.acp.close(); this.child.stdin.end(); }
  private terminate(): void {
    this.descendants.terminate(this.spec.timings?.eofKillGraceMs ?? DEFAULT_RUNNER_TIMINGS.eofKillGraceMs);
    signalSession(this.child, 'SIGTERM');
    this.kill = setTimeout(() => signalSession(this.child, 'SIGKILL'), this.spec.timings?.eofKillGraceMs ?? DEFAULT_RUNNER_TIMINGS.eofKillGraceMs);
  }
  interrupt(): void {
    if (this.requestedClose) return;
    this.interrupted = true; this.beginClose();
    if (this.ready && (this.busy || this.acp.agentWorking)) {
      try { this.acp.cancel(); } catch { /* The shutdown deadline still owns cleanup. */ }
      // The CLI answers cancelled before the open command closes; keep the transport for that.
      this.term = setTimeout(() => { this.closeInput(); this.terminate(); }, this.spec.timings?.eofTermGraceMs ?? DEFAULT_RUNNER_TIMINGS.eofTermGraceMs);
    } else { this.closeInput(); this.terminate(); }
  }
  private fail(error: unknown): void {
    if (this.requestedClose) return;
    this.failure ??= error instanceof Error ? error : new Error(String(error));
    this.end();
  }
  private clearAutoEnd(): void { clearTimeout(this.autoEnd); this.autoEnd = undefined; }
  private scheduleAutoEnd(): void {
    if (!this.open || !this.options.autoEndAfterFirstTurn || this.agentAcks || this.humanAcks || this.autoEnd) return;
    this.autoEnd = setTimeout(() => {
      this.autoEnd = undefined;
      if (this.open && !this.busy && !this.acp.agentWorking && !this.humanAcks && !this.queue.length && this.options.shouldAutoEnd?.() !== false) this.end();
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
    this.accepting = false; this.acp.close(); this.clearAutoEnd(); clearTimeout(this.quietTimer); clearTimeout(this.term); clearTimeout(this.kill); clearTimeout(this.deadline);
    this.descendants.terminate(this.spec.timings?.eofKillGraceMs ?? DEFAULT_RUNNER_TIMINGS.eofKillGraceMs);
    try { this.launch.release(); } catch { /* Pruning drops a lease whose owner process has exited. */ }
    await boot;
    await this.bridge?.close();
    const unexpected = !this.requestedClose && (code !== 0 || this.busy);
    if (this.timedOut || this.failure || unexpected || this.reportedFailure) {
      await logAntigravityFailure(this.runtime.geminiDir, this.child.pid, 'session', this.failure ?? this.providerError ?? `Agent exited code ${code}`, this.runtime.env, this.stderr);
    }
    await rm(this.runtime.temp, { recursive: true, force: true });
    if (this.timedOut) throw new Error(`Antigravity timed out after ${this.limit}ms`);
    const stderr = redactAntigravityDiagnostics(this.stderr, this.runtime.env).trim();
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
