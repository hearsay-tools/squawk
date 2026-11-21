import { rm } from 'node:fs/promises';
import { z } from 'zod';
import type { AgentEvent, AgentRunResult, AgentRunSpec, AgentSession, ContentBlock, SessionOptions } from '../../core/agent-runner.ts';
import { SessionEndedBeforeAcknowledgement } from '../../core/agent-runner-values.ts';
import { openingContent, validSkillMessage } from '../../core/skill-trigger.ts';
import { spawnSessionLeader, signalSession } from '../../core/session-process.ts';
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

const configSchema = z.array(z.object({ id: z.string(), category: z.string().optional() }).passthrough());
function contentBlocks(content: readonly ContentBlock[]): Record<string, unknown>[] {
  return content.map(block => {
    if (block.type === 'skill') return { type: 'text', text: `/${block.id}${block.args ? ` ${block.args}` : ''}` };
    if (block.type === 'image') return { type: 'image', data: block.source.data, mimeType: block.source.media_type };
    return block;
  });
}
export function filterAntigravityUpdate(update: Record<string, unknown>): boolean {
  const content = z.object({ text: z.string() }).safeParse(update.content);
  return !(update.sessionUpdate === 'agent_message_chunk' && content.success && content.data.text.includes('Concurrent receive_steps() calls are not supported'));
}

/** Owns process lifetime. AcpSession owns wire parsing and outstanding native requests. */
export class AntigravitySession implements AgentSession {
  readonly result: Promise<AgentRunResult>;
  private readonly runtime;
  private readonly child;
  private readonly acp: AcpSession;
  private readonly exited: Promise<number | null>;
  private readonly output: AgentRunResult = { text: '', toolCalls: [], tokensUsed: 0 };
  private readonly stderr: string[] = [];
  private readonly queue: ContentBlock[][] = [];
  private bridge: Awaited<ReturnType<typeof antigravityMcp>>;
  private ready = false;
  private busy = false;
  private accepting = true;
  private requestedClose = false;
  private timedOut = false;
  private failure: Error | undefined;
  private pendingAsk: string | undefined;
  private humanAcks = 0;
  private heldSteers = 0;
  private configOptions: unknown;
  private autoEnd: NodeJS.Timeout | undefined;
  private term: NodeJS.Timeout | undefined;
  private kill: NodeJS.Timeout | undefined;
  private deadline: NodeJS.Timeout | undefined;
  private readonly limit: number;
  constructor(bin: string, private readonly spec: AgentRunSpec, private readonly onEvent: ((event: AgentEvent) => void) | undefined,
    private readonly options: SessionOptions, timeoutMs?: number) {
    this.runtime = antigravityEnv(bin, spec);
    this.child = spawnSessionLeader(bin, ['--uid='], { cwd: spec.cwd, env: this.runtime.env, scope: spec.scope, timings: spec.timings });
    boundOutputDrainAfterExit(this.child);
    this.acp = this.createAcp();
    this.child.stderr.setEncoding('utf8'); this.child.stderr.on('data', (chunk: string) => this.stderr.push(chunk));
    this.child.on('error', error => { this.failure = error; this.acp.transport.close(error); });
    this.exited = new Promise(resolve => this.child.once('close', resolve));
    this.limit = spec.timeoutMs ?? timeoutMs ?? spec.timings?.runTimeoutMs ?? DEFAULT_RUNNER_TIMINGS.runTimeoutMs;
    if (this.limit > 0) this.deadline = setTimeout(() => { this.timedOut = true; this.emit({ type: 'error', message: `Antigravity timed out after ${this.limit}ms` }); this.interrupt(); }, this.limit);
    const boot = this.boot().catch(error => this.fail(error));
    this.result = this.settle(boot);
  }
  get pid(): number | undefined { return this.child.pid; }
  get open(): boolean { return this.accepting; }
  private emit(event: AgentEvent): void {
    if (event.type === 'text') this.output.text += event.text;
    if (event.type === 'tool-call') this.output.toolCalls.push({ id: event.id, name: event.tool, input: event.input });
    if (event.type === 'session') this.output.sessionId = event.sessionId;
    this.onEvent?.(event);
  }
  private createAcp(): AcpSession {
    const spec = this.spec;
    return new AcpSession({ input: this.child.stdin, output: this.child.stdout }, {
      backend: 'antigravity', clientInfo: { name: 'squawk', version: '1' }, event: event => this.emit(event),
      onActivity: () => this.options.onActivity?.(),
      uiEvent: event => {
        if (event.type === 'ask.requested') this.pendingAsk = event.requestId;
        this.options.onUiEvent?.(event);
      }, hooks: {
        selectAuthMethod: hello => this.runtime.env.GEMINI_API_KEY && hello.authMethods.some(method => method.id === 'gemini-api-key') ? 'gemini-api-key' : undefined,
        normalizeTool: antigravityTool, normalizeUsage: antigravityUsage,
        normalizeOptions: value => { this.configOptions = value; },
        permissionAsk: antigravityAsk, permissionPolicy: request => permissionPolicy(spec.toolGrant, request, productEnv('APPROVAL_GATE', this.runtime.env) === '1', spec.squawkTools ? squawkToolNames(spec.env ?? {}).map(name => `${spec.squawkTools!.name}_${name}`) : []),
        readTextFile: params => antigravityReadFile(params, spec.cwd, spec.toolGrant),
        sessionParams: () => ({ _meta: { antigravity: { systemPrompt: { append: spec.systemPrompt ?? '' } } },
          ...(spec.additionalDirectories ? { additionalDirectories: spec.additionalDirectories } : {}) }),
        filterUpdate: filterAntigravityUpdate,
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
      if (!option) throw new Error('Antigravity has no thought_level config option');
      await this.acp.setConfigOption(option.id, this.spec.effort);
    }
    if (!this.open) return;
    this.ready = true;
    void this.submit(openingContent(this.spec, !!this.spec.resume)).catch(error => this.fail(error));
  }
  private submit(content: ContentBlock[]): Promise<void> {
    this.clearAutoEnd();
    if (this.busy) return this.acp.steer(contentBlocks(content));
    this.busy = true;
    return this.acp.prompt(contentBlocks(content)).then(value => {
      const usage = antigravityUsage(value.usage);
      if (usage) { this.output.tokensUsed += usage.total; this.emit({ type: 'token-usage', tokensUsed: this.output.tokensUsed }); }
    }).finally(() => {
      this.busy = false; this.pendingAsk = undefined;
      if (this.open && this.queue.length) void this.submit(this.queue.shift()!).catch(error => this.fail(error));
      else if (this.open) { this.options.onAgentInputReady?.(); this.scheduleEnd(); }
    });
  }
  sendMessage(content: ContentBlock[]): boolean {
    if (!this.open || !validSkillMessage(content)) return false;
    if (this.pendingAsk) return this.answerAsk(content);
    if (!this.ready) { this.queue.push(content); return true; }
    const steered = this.busy;
    this.humanAcks++;
    if (steered) this.heldSteers++;
    void this.submit(content).then(() => this.releaseHuman(steered), error => { this.releaseHuman(steered); this.fail(error); });
    return true;
  }
  private answerAsk(content: ContentBlock[]): boolean {
    try {
      const text = content.filter(block => block.type === 'text').map(block => block.text).join('\n');
      if (!this.acp.respondAsk(this.pendingAsk!, text)) return false;
      this.pendingAsk = undefined; return true;
    } catch (error) { this.emit({ type: 'note', message: String(error) }); return false; }
  }
  private releaseHuman(steered: boolean): void {
    this.humanAcks = Math.max(0, this.humanAcks - 1);
    if (steered) this.heldSteers = Math.max(0, this.heldSteers - 1);
    this.options.onAgentInputReady?.();
  }
  sendAgentMessage(content: ContentBlock[]): false | Promise<void> {
    if (!this.open || !this.ready || this.humanAcks || this.pendingAsk || !validSkillMessage(content)) return false;
    return this.submit(content).catch(error => { if (!this.open && this.requestedClose) throw new SessionEndedBeforeAcknowledgement(); throw error; });
  }
  respondPermission(id: string, option: string): boolean { return this.acp.respondPermission(id, option); }
  discardQueuedMessages(): void { this.queue.length = 0; this.heldSteers = 0; }
  // Idle prompts release at synchronous turn.started. Steers release at their response while
  // the original turn remains open, or on close/discard. No native consumption signal exists.
  holdsHumanInput(): boolean { return this.heldHumanInputCount() > 0; }
  heldHumanInputCount(): number { return this.queue.length + this.heldSteers; }
  end(): void {
    if (!this.open) return;
    this.requestedClose = true; this.accepting = false; this.clearAutoEnd(); this.queue.length = 0; this.pendingAsk = undefined;
    this.acp.close(); this.child.stdin.end();
    this.term = setTimeout(() => this.terminate(), this.spec.timings?.eofTermGraceMs ?? DEFAULT_RUNNER_TIMINGS.eofTermGraceMs);
  }
  private terminate(): void {
    signalSession(this.child, 'SIGTERM');
    this.kill = setTimeout(() => signalSession(this.child, 'SIGKILL'), this.spec.timings?.killGraceMs ?? DEFAULT_RUNNER_TIMINGS.killGraceMs);
  }
  interrupt(): void {
    if (!this.open) return;
    if (this.ready && this.busy) { try { this.acp.cancel(); } catch { /* Exit owns cleanup. */ } }
    this.end(); clearTimeout(this.term);
    this.term = setTimeout(() => this.terminate(), AUTO_END_DELAY_MS);
  }
  private fail(error: unknown): void {
    if (!this.open) return;
    this.failure = error instanceof Error ? error : new Error(String(error));
    this.emit({ type: 'error', message: this.failure.message });
    this.options.onUiEvent?.({ type: 'session.error', message: this.failure.message, fatal: true });
    this.interrupt();
  }
  private clearAutoEnd(): void { clearTimeout(this.autoEnd); this.autoEnd = undefined; }
  private scheduleEnd(): void {
    if (!this.options.autoEndAfterFirstTurn) return;
    this.autoEnd = setTimeout(() => {
      if (this.open && !this.busy && !this.humanAcks && !this.queue.length && this.options.shouldAutoEnd?.() !== false) this.end();
    }, AUTO_END_DELAY_MS);
  }
  private async settle(boot: Promise<void>): Promise<AgentRunResult> {
    const code = await this.exited;
    this.accepting = false; this.acp.close(); this.clearAutoEnd(); clearTimeout(this.term); clearTimeout(this.kill); clearTimeout(this.deadline);
    await boot;
    await this.bridge?.close();
    await rm(this.runtime.temp, { recursive: true, force: true });
    if (this.timedOut) throw new Error(`Antigravity timed out after ${this.limit}ms`);
    if (this.failure) throw this.failure;
    if (!this.requestedClose && (code !== 0 || this.busy)) throw new Error(`Antigravity exited ${code}: ${this.stderr.join('').trim()}`);
    this.emit({ type: 'done' }); this.output.text = this.output.text.trim(); return this.output;
  }
}
