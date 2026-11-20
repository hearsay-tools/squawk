import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type {
  AgentEvent, AgentRunResult, AgentRunSpec, AgentRunner, AgentSession, ContentBlock, SessionOptions,
} from '../../core/agent-runner.ts';
import { buildChildEnv } from '../../core/agent-env.ts';
import { readNdjson } from '../../core/ndjson.ts';
import { signalSession, spawnSessionLeader } from '../../core/session-process.ts';
import type { UiEvent } from '../../core/ui-events.ts';
import { FIXTURE_BIN_ENV, FIXTURE_FACTS, FIXTURE_SPEC_SUPPORT } from './data.testkit.ts';

/** The frames the fixture mock (`scripts/mock-fixture-runner.mjs`) writes to stdout. */
type Frame =
  | { type: 'ready'; sessionId: string }
  | { type: 'turn-start' }
  | { type: 'text'; text: string }
  | { type: 'usage'; input: number; output: number }
  | { type: 'turn-end' }
  | { type: 'error'; message: string };

/**
 * The adapter of the fixture runner: the smallest `AgentRunner` that drives a native process. It spawns
 * the executable `FIXTURE_RUNNER_BIN` names, writes one JSON prompt line per turn and maps the frames
 * the mock answers with onto the v1 and v2 event streams. A turn that is still running holds a later
 * prompt (the facts declare `boundary` delivery). It loads only through the definition's `loadAdapter`.
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
    const env = buildChildEnv({ backend: 'fixture', extraEnv: spec.env });
    const child: ChildProcessWithoutNullStreams = spawnSessionLeader(bin, [], { cwd: spec.cwd, env, timings: spec.timings, scope: spec.scope });

    let open = true;
    let finished = false;
    let busy = false;
    let turns = 0;
    let sessionId = '';
    let text = '';
    let tokensUsed = 0;
    const held: string[] = [];
    let settle!: { resolve: (result: AgentRunResult) => void; reject: (error: Error) => void };
    const result = new Promise<AgentRunResult>((resolve, reject) => { settle = { resolve, reject }; });
    const timer = spec.timeoutMs === undefined || spec.timeoutMs <= 0 ? undefined : setTimeout(() => session.interrupt(), spec.timeoutMs);
    timer?.unref();

    const prompt = (message: string): void => {
      busy = true;
      child.stdin.write(`${JSON.stringify({ type: 'prompt', text: message })}\n`);
    };
    const finish = (error?: Error): void => {
      if (finished) return;
      finished = true;
      open = false;
      clearTimeout(timer);
      if (error) { settle.reject(error); return; }
      onEvent({ type: 'done' });
      emitUi({ type: 'session.ended', reason: 'end_turn' });
      settle.resolve({ text: text.trim(), toolCalls: [], tokensUsed, sessionId });
    };

    const onFrame = (frame: Frame): void => {
      switch (frame.type) {
        case 'ready':
          sessionId = frame.sessionId;
          onEvent({ type: 'session', sessionId, resumed: false });
          emitUi({ type: 'session.started', sessionId, backend: 'fixture', cwd: spec.cwd });
          return;
        case 'turn-start':
          turns += 1;
          emitUi({ type: 'turn.started', turnId: `turn-${turns}` });
          return;
        case 'text':
          text += frame.text;
          onEvent({ type: 'text', text: frame.text });
          emitUi({ type: 'item.completed', item: { kind: 'message', id: `message-${turns}`, role: 'assistant', text: frame.text } });
          return;
        case 'usage': {
          const total = frame.input + frame.output;
          tokensUsed += total;
          onEvent({ type: 'token-usage', tokensUsed });
          emitUi({ type: 'usage.updated', usage: { input: frame.input, output: frame.output, total } });
          return;
        }
        case 'turn-end': {
          busy = false;
          onEvent({ type: 'turn-end' });
          emitUi({ type: 'turn.completed', turnId: `turn-${turns}`, stopReason: 'end_turn', usage: { input: 0, output: 0, total: tokensUsed } });
          const next = held.shift();
          if (next !== undefined) prompt(next);
          else if (opts.autoEndAfterFirstTurn && (opts.shouldAutoEnd?.() ?? true)) session.end();
          return;
        }
        case 'error':
          busy = false;
          onEvent({ type: 'error', message: frame.message });
          emitUi({ type: 'session.error', message: frame.message, fatal: true });
          emitUi({ type: 'turn.completed', turnId: `turn-${turns}`, stopReason: 'error' });
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
    child.once('close', () => { void reading.then(() => finish()); });
    child.stdin.on('error', () => { /* the process is gone; its close finishes the session */ });

    const blocksText = (blocks: ContentBlock[]) => blocks.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n');
    const session: AgentSession = {
      result,
      get pid() { return child.pid; },
      get open() { return open; },
      sendMessage(blocks) {
        if (!open) return false;
        if (busy) held.push(blocksText(blocks)); else prompt(blocksText(blocks));
        return true;
      },
      sendAgentMessage(blocks) {
        if (!open || busy) return false;
        prompt(blocksText(blocks));
        return Promise.resolve();
      },
      discardQueuedMessages() { held.length = 0; },
      holdsHumanInput: () => held.length > 0,
      heldHumanInputCount: () => held.length,
      end() {
        if (!open) return;
        open = false;
        child.stdin.end();
      },
      interrupt() {
        open = false;
        signalSession(child, 'SIGTERM');
      },
    };
    prompt(spec.userPrompt);
    return session;
  }
}
