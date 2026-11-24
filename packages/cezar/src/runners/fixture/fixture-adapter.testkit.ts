import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type {
  AgentEvent, AgentRunResult, AgentRunSpec, AgentRunner, AgentSession, AgentToolCallRecord, ContentBlock, SessionOptions,
} from '../../core/agent-runner.ts';
import { buildChildEnv } from '../../core/agent-env.ts';
import { readNdjson } from '../../core/ndjson.ts';
import { AUTO_END_DELAY_MS } from '../../core/runner-runtime.ts';
import { signalSession, spawnSessionLeader } from '../../core/session-process.ts';
import type { UiEvent } from '../../core/ui-events.ts';
import { FIXTURE_BIN_ENV, FIXTURE_FACTS, FIXTURE_SPEC_SUPPORT } from './data.testkit.ts';

/** The frames the fixture mock (`scripts/mock-fixture-runner.mjs`) writes to stdout. */
type Frame =
  | { type: 'ready'; sessionId: string }
  | { type: 'consumed'; ids: string[] }
  | { type: 'progress' }
  | { type: 'turn-start' }
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool-start'; call: { id: string; name: string; input: unknown } }
  | { type: 'tool-end'; call: { id: string; name: string; input: unknown; output: string; isError?: boolean } }
  | { type: 'usage'; input: number; output: number }
  | { type: 'turn-end'; consumedIds?: string[] }
  | { type: 'error'; message: string };

/**
 * The adapter of the fixture runner: a lightweight `AgentRunner` over `mock-fixture-runner.mjs`
 * used as the single fast scenario runner for runner-agnostic engine tests. It writes JSON prompt
 * lines with correlation ids on stdin, reports observable consumption, supports direct Squawk tool
 * IPC via `CEZ_TOOL_SOCKET`, and maps frames onto the v1 and v2 event streams.
 */
export class FixtureAdapter implements AgentRunner {
  readonly backend = 'fixture';
  readonly specSupport = FIXTURE_SPEC_SUPPORT;
  readonly systemPromptOnResume = FIXTURE_FACTS.systemPromptOnResume;
  readonly inputDelivery = FIXTURE_FACTS.inputDelivery;
  readonly facts = FIXTURE_FACTS;

  async run(spec: AgentRunSpec, onEvent?: (event: AgentEvent) => void): Promise<AgentRunResult> {
    return this.startSession(spec, onEvent, { autoEndAfterFirstTurn: true }).result;
  }

  async interrupt(): Promise<void> { /* a session owns its process: AgentSession.interrupt */ }

  startSession(spec: AgentRunSpec, onEvent: (event: AgentEvent) => void = () => {}, opts: SessionOptions = {}): AgentSession {
    const emitUi = (event: UiEvent) => opts.onUiEvent?.(event);
    const bin = process.env[FIXTURE_BIN_ENV] ?? 'fixture-runner';
    const argv: string[] = [];
    if (spec.sessionId) argv.push(spec.resume ? '--resume' : '--session-id', spec.sessionId);
    if (spec.systemPrompt) argv.push('--append-system-prompt', spec.systemPrompt);
    const env = buildChildEnv({ backend: 'fixture', extraEnv: spec.env });
    const child: ChildProcessWithoutNullStreams = spawnSessionLeader(bin, argv, { cwd: spec.cwd, env, timings: spec.timings, scope: spec.scope });

    let open = true;
    let finished = false;
    let interrupted = false;
    let endedBySquawk = false;
    let timedOut = false;
    let turns = 0;
    let sessionId = spec.sessionId ?? '';
    let text = '';
    let tokensUsed = 0;
    const toolCalls: AgentToolCallRecord[] = [];
    const submissions = new Map<string, readonly string[]>();
    const humanUnsettled = new Set<string>();
    let autoEndTimer: ReturnType<typeof setTimeout> | undefined;
    let settle!: { resolve: (result: AgentRunResult) => void; reject: (error: Error) => void };
    const result = new Promise<AgentRunResult>((resolve, reject) => { settle = { resolve, reject }; });

    const limitMs = spec.timeoutMs === 0 ? undefined : (spec.timeoutMs ?? spec.timings?.runTimeoutMs);
    const timer = limitMs === undefined || limitMs <= 0 ? undefined : setTimeout(() => {
      timedOut = true;
      const message = `fixture runner timed out after ${limitMs}ms`;
      onEvent({ type: 'error', message });
      emitUi({ type: 'session.error', message, fatal: true });
      session.interrupt();
    }, limitMs);
    timer?.unref();

    const clearAutoEnd = () => {
      if (autoEndTimer !== undefined) { clearTimeout(autoEndTimer); autoEndTimer = undefined; }
    };

    const writePrompt = (message: string, id?: string, onWrite?: (error?: Error | null) => void): boolean => {
      if (!open || child.stdin.destroyed || child.stdin.writableEnded) return false;
      clearAutoEnd();
      const payload = id ? { type: 'prompt', text: message, id } : { type: 'prompt', text: message };
      if (onWrite) child.stdin.write(`${JSON.stringify(payload)}\n`, onWrite);
      else child.stdin.write(`${JSON.stringify(payload)}\n`);
      return true;
    };

    const finish = (error?: Error, exitCode?: number | null): void => {
      if (finished) return;
      finished = true;
      open = false;
      clearTimeout(timer);
      clearAutoEnd();
      if (error) { settle.reject(error); return; }
      if (timedOut) { settle.reject(new Error(`fixture runner timed out after ${limitMs}ms`)); return; }
      if (!interrupted && !endedBySquawk && exitCode !== null && exitCode !== undefined && exitCode !== 0) {
        const message = `fixture runner exited with code ${exitCode}`;
        onEvent({ type: 'error', message });
        emitUi({ type: 'session.error', message, fatal: true });
        settle.reject(new Error(message));
        return;
      }
      onEvent({ type: 'done' });
      emitUi({ type: 'session.ended', reason: interrupted ? 'cancelled' : 'end_turn' });
      settle.resolve({ text: text.trim(), toolCalls, tokensUsed, sessionId });
    };

    const scheduleAutoEnd = () => {
      if (!opts.autoEndAfterFirstTurn || !open) return;
      clearAutoEnd();
      autoEndTimer = setTimeout(() => {
        autoEndTimer = undefined;
        if (open && (opts.shouldAutoEnd?.() ?? true)) session.end();
      }, AUTO_END_DELAY_MS);
      autoEndTimer.unref?.();
    };

    const consumeIds = (wireIds: readonly string[]): void => {
      const consumed: string[] = [];
      for (const wireId of wireIds) {
        humanUnsettled.delete(wireId);
        const ids = submissions.get(wireId);
        if (!ids) continue;
        submissions.delete(wireId);
        consumed.push(...ids);
      }
      if (consumed.length) opts.onAgentInputConsumed?.(consumed);
    };

    const onToolFrame = (frame: Extract<Frame, { type: 'tool-start' | 'tool-end' }>): void => {
      if (frame.type === 'tool-start') {
        toolCalls.push({ id: frame.call.id, name: frame.call.name, input: frame.call.input });
        onEvent({ type: 'tool-call', id: frame.call.id, tool: frame.call.name, input: frame.call.input });
        // oxlint-disable-next-line cez/test-enum-literal -- UiToolItem.status is ToolStatus, not RunStatus
        emitUi({ type: 'item.started', item: { kind: 'tool', id: frame.call.id, name: frame.call.name, toolKind: 'other', title: frame.call.name, status: 'running', input: frame.call.input } });
        return;
      }
      onEvent({ type: 'tool-result', toolCallId: frame.call.id, result: frame.call.output, isError: Boolean(frame.call.isError) });
      // oxlint-disable-next-line cez/test-enum-literal -- UiToolItem.status is ToolStatus, not RunStatus
      emitUi({ type: 'item.completed', item: { kind: 'tool', id: frame.call.id, name: frame.call.name, toolKind: 'other', title: frame.call.name, status: frame.call.isError ? 'failed' : 'completed', input: frame.call.input, output: frame.call.output } });
    };

    const onFrame = (frame: Frame): void => {
      opts.onActivity?.();
      switch (frame.type) {
        case 'ready':
          sessionId = frame.sessionId;
          onEvent({ type: 'session', sessionId, resumed: Boolean(spec.resume && spec.sessionId === sessionId) });
          emitUi({ type: 'session.started', sessionId, backend: 'fixture', cwd: spec.cwd });
          return;
        case 'progress':
          return;
        case 'consumed':
          consumeIds(frame.ids);
          return;
        case 'turn-start':
          turns += 1;
          emitUi({ type: 'turn.started', turnId: `turn-${turns}` });
          return;
        case 'text':
          text += frame.text;
          onEvent({ type: 'text', text: frame.text });
          emitUi({ type: 'item.completed', item: { kind: 'message', id: `message-${turns}-${text.length}`, role: 'assistant', text: frame.text } });
          return;
        case 'reasoning':
          emitUi({ type: 'item.completed', item: { kind: 'reasoning', id: `reasoning-${turns}`, text: frame.text } });
          return;
        case 'tool-start':
        case 'tool-end':
          onToolFrame(frame);
          return;
        case 'usage': {
          const total = frame.input + frame.output;
          tokensUsed += total;
          onEvent({ type: 'token-usage', tokensUsed });
          emitUi({ type: 'usage.updated', usage: { input: frame.input, output: frame.output, total } });
          return;
        }
        case 'turn-end':
          consumeIds(frame.consumedIds ?? []);
          emitUi({ type: 'turn.completed', turnId: `turn-${turns}`, stopReason: 'end_turn', usage: { input: 0, output: 0, total: tokensUsed } });
          onEvent({ type: 'turn-end' });
          scheduleAutoEnd();
          return;
        case 'error':
          onEvent({ type: 'error', message: frame.message });
          emitUi({ type: 'session.error', message: frame.message, fatal: true });
          emitUi({ type: 'turn.completed', turnId: `turn-${turns}`, stopReason: 'error' });
          onEvent({ type: 'turn-end' });
          session.end();
          return;
      }
    };

    // A missing executable fails before any wire exists: one error on the existing failure channels.
    child.once('error', (error: NodeJS.ErrnoException) => {
      const message = error.code === 'ENOENT'
        ? `fixture runner not found on PATH or at ${bin}: install it, or set ${FIXTURE_BIN_ENV} (${error.message})`
        : `fixture runner failed to start: ${error.message}`;
      onEvent({ type: 'error', message });
      emitUi({ type: 'session.error', message, fatal: true });
      finish(new Error(message));
    });

    const reading = (async () => {
      for await (const line of readNdjson(child.stdout)) {
        try { onFrame(JSON.parse(line) as Frame); } catch { /* a line the mock did not write is not a frame */ }
      }
    })();
    child.once('close', (code) => { void reading.then(() => finish(undefined, code)); });
    child.stdin.on('error', () => { /* the process is gone; its close finishes the session */ });

    const blocksText = (blocks: ContentBlock[]) => blocks.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n');
    const session: AgentSession = {
      result,
      get pid() { return child.pid; },
      get open() { return open; },
      sendMessage(blocks) {
        const wireId = randomUUID();
        humanUnsettled.add(wireId);
        if (!writePrompt(blocksText(blocks), wireId)) {
          humanUnsettled.delete(wireId);
          return false;
        }
        return true;
      },
      sendAgentMessage(blocks, inputIds) {
        if (!open) return false;
        const wireId = randomUUID();
        if (inputIds?.length) submissions.set(wireId, [...inputIds]);
        let resolve!: () => void;
        let reject!: (error: Error) => void;
        const acknowledged = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
        const sent = writePrompt(blocksText(blocks), wireId, (error) => {
          if (error) reject(error);
          else resolve();
        });
        if (!sent) {
          submissions.delete(wireId);
          return false;
        }
        return acknowledged;
      },
      discardQueuedMessages() { humanUnsettled.clear(); },
      holdsHumanInput: () => humanUnsettled.size > 0,
      heldHumanInputCount: () => humanUnsettled.size,
      end() {
        if (!open) return;
        open = false;
        endedBySquawk = true;
        clearAutoEnd();
        child.stdin.end();
      },
      interrupt() {
        open = false;
        interrupted = true;
        clearAutoEnd();
        signalSession(child, 'SIGTERM');
      },
    };
    writePrompt(spec.userPrompt);
    return session;
  }
}
