// The external runner's adapter, loaded on demand by `loadAdapter`. It starts `agent.mjs` as a
// session leader, writes prompt lines on its stdin and maps its frames onto Squawk's event streams.
// Runtime helpers come from `@hearsay-tools/squawk/plugin/runtime` only.
import { randomUUID } from 'node:crypto';
import { AUTO_END_DELAY_MS, buildChildEnv, readNdjson, signalSession, spawnSessionLeader } from '@hearsay-tools/squawk/plugin/runtime';

const blocksText = blocks => blocks.flatMap(block => (block.type === 'text' ? [block.text] : [])).join('\n');

export class ExternalAdapter {
  constructor({ agent, facts, specSupport }) {
    this.backend = 'ext-runner';
    this.agent = agent;
    this.facts = facts;
    this.specSupport = specSupport;
    this.systemPromptOnResume = facts.systemPromptOnResume;
    this.inputDelivery = facts.inputDelivery;
  }

  async run(spec, onEvent) {
    return this.startSession(spec, onEvent, { autoEndAfterFirstTurn: true }).result;
  }

  async interrupt() { /* a session owns its process: AgentSession.interrupt */ }

  startSession(spec, onEvent = () => {}, opts = {}) {
    const emitUi = event => opts.onUiEvent?.(event);
    const argv = [this.agent];
    if (spec.sessionId) argv.push(spec.resume ? '--resume' : '--session-id', spec.sessionId);
    if (spec.model) argv.push('--model', spec.model);
    const env = buildChildEnv({ backend: this.backend, extraEnv: spec.env });
    const child = spawnSessionLeader(process.execPath, argv, { cwd: spec.cwd, env, timings: spec.timings, scope: spec.scope });

    let open = true;
    let finished = false;
    let interrupted = false;
    let endedBySquawk = false;
    let turns = 0;
    let sessionId = spec.sessionId ?? '';
    let text = '';
    let tokensUsed = 0;
    let autoEndTimer;
    const toolCalls = [];
    const submissions = new Map();
    const humanUnsettled = new Set();
    let settle;
    const result = new Promise((resolve, reject) => { settle = { resolve, reject }; });

    const clearAutoEnd = () => {
      if (autoEndTimer !== undefined) { clearTimeout(autoEndTimer); autoEndTimer = undefined; }
    };
    const writePrompt = (message, id, onWrite) => {
      if (!open || child.stdin.destroyed || child.stdin.writableEnded) return false;
      clearAutoEnd();
      child.stdin.write(`${JSON.stringify(id ? { type: 'prompt', text: message, id } : { type: 'prompt', text: message })}\n`, onWrite);
      return true;
    };
    const finish = (error, exitCode) => {
      if (finished) return;
      finished = true;
      open = false;
      clearAutoEnd();
      if (error) { settle.reject(error); return; }
      if (!interrupted && !endedBySquawk && exitCode !== null && exitCode !== undefined && exitCode !== 0) {
        const message = `external agent exited with code ${exitCode}`;
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
    const consumeIds = wireIds => {
      const consumed = [];
      for (const wireId of wireIds) {
        humanUnsettled.delete(wireId);
        const ids = submissions.get(wireId);
        if (!ids) continue;
        submissions.delete(wireId);
        consumed.push(...ids);
      }
      if (consumed.length) opts.onAgentInputConsumed?.(consumed);
    };
    const onToolFrame = frame => {
      const { call } = frame;
      if (frame.type === 'tool-start') {
        toolCalls.push({ id: call.id, name: call.name, input: call.input });
        onEvent({ type: 'tool-call', id: call.id, tool: call.name, input: call.input });
        emitUi({ type: 'item.started', item: { kind: 'tool', id: call.id, name: call.name, toolKind: 'other', title: call.name, status: 'running', input: call.input } });
        return;
      }
      onEvent({ type: 'tool-result', toolCallId: call.id, result: call.output, isError: Boolean(call.isError) });
      emitUi({ type: 'item.completed', item: { kind: 'tool', id: call.id, name: call.name, toolKind: 'other', title: call.name, status: call.isError ? 'failed' : 'completed', input: call.input, output: call.output } });
    };
    const onFrame = frame => {
      opts.onActivity?.();
      switch (frame.type) {
        case 'ready':
          sessionId = frame.sessionId;
          onEvent({ type: 'session', sessionId, resumed: Boolean(spec.resume && spec.sessionId === sessionId) });
          emitUi({ type: 'session.started', sessionId, backend: this.backend, cwd: spec.cwd });
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
          emitUi({ type: 'turn.completed', turnId: `turn-${turns}`, stopReason: 'end_turn', usage: { input: 0, output: 0, total: tokensUsed } });
          onEvent({ type: 'turn-end' });
          scheduleAutoEnd();
          return;
        default:
      }
    };

    child.once('error', error => {
      const message = `external agent failed to start: ${error.message}`;
      onEvent({ type: 'error', message });
      emitUi({ type: 'session.error', message, fatal: true });
      finish(new Error(message));
    });
    const reading = (async () => {
      for await (const line of readNdjson(child.stdout)) {
        let frame;
        try { frame = JSON.parse(line); } catch { continue; }
        onFrame(frame);
      }
    })();
    child.once('close', code => { void reading.then(() => finish(undefined, code)); });
    child.stdin.on('error', () => { /* the process is gone; its close finishes the session */ });

    const session = {
      result,
      get pid() { return child.pid; },
      get open() { return open; },
      sendMessage(blocks) {
        const wireId = randomUUID();
        humanUnsettled.add(wireId);
        if (writePrompt(blocksText(blocks), wireId)) return true;
        humanUnsettled.delete(wireId);
        return false;
      },
      sendAgentMessage(blocks, inputIds) {
        if (!open) return false;
        const wireId = randomUUID();
        if (inputIds?.length) submissions.set(wireId, [...inputIds]);
        let resolve;
        let reject;
        const acknowledged = new Promise((yes, no) => { resolve = yes; reject = no; });
        if (writePrompt(blocksText(blocks), wireId, error => (error ? reject(error) : resolve()))) return acknowledged;
        submissions.delete(wireId);
        return false;
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
