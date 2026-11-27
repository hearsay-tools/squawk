// Plain-JS ACP adapter built on `@hearsay-tools/squawk/plugin/acp`. Drives `scripts/mock-acp.mjs`
// resolved through `nativeMockPath`, with a minimal HTTP MCP bridge over `AcpTransport`.
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { AcpRpcError, AcpSession, AcpTransport } from '@hearsay-tools/squawk/plugin/acp';
import {
  AUTO_END_DELAY_MS,
  buildChildEnv,
  nativeMockPath,
  signalSession,
  spawnSessionLeader,
} from '@hearsay-tools/squawk/plugin/runtime';

const blocksToAcp = blocks => blocks.flatMap(block => (block.type === 'text' ? [{ type: 'text', text: block.text }] : []));

async function startMcpBridge(spec, env) {
  if (!spec.squawkTools) return undefined;
  const child = spawnSessionLeader(spec.squawkTools.command, spec.squawkTools.args, { cwd: spec.cwd, env, scope: spec.scope });
  child.stderr.resume();
  const exited = new Promise(resolve => child.once('close', resolve));
  const rpc = new AcpTransport(
    { input: child.stdin, output: child.stdout },
    { notification: () => {}, request: () => { throw new AcpRpcError(-32601, 'Unsupported request'); } },
  );
  child.on('error', error => rpc.close(error));
  const token = randomUUID();
  const server = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(403).end(); return; }
    void (async () => {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const frame = JSON.parse(raw);
      if (frame.id === undefined) { rpc.notify(frame.method, frame.params); res.writeHead(202).end(); return; }
      try {
        const result = await rpc.request(frame.method, frame.params);
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result }));
      } catch (error) {
        const code = error instanceof AcpRpcError ? error.code : -32603;
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: frame.id, error: { code, message: String(error) } }));
      }
    })().catch(() => { if (!res.headersSent) res.writeHead(400); res.end(); });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address();
  return {
    descriptor: { type: 'http', name: 'squawk', url: `http://127.0.0.1:${port}/mcp`, headers: [{ name: 'Authorization', value: `Bearer ${token}` }] },
    async close() {
      rpc.close();
      server.closeAllConnections();
      server.close();
      child.stdin.end();
      if (child.exitCode === null && child.signalCode === null) { signalSession(child, 'SIGTERM'); await exited; }
    },
  };
}

export class ExternalAcpAdapter {
  constructor({ facts, specSupport, mock }) {
    this.backend = 'ext-acp-runner';
    this.facts = facts;
    this.specSupport = specSupport;
    this.mock = mock;
    this.systemPromptOnResume = facts.systemPromptOnResume;
    this.inputDelivery = facts.inputDelivery;
  }

  async run(spec, onEvent) {
    return this.startSession(spec, onEvent, { autoEndAfterFirstTurn: true }).result;
  }

  async interrupt() { /* session owns its child */ }

  startSession(spec, onEvent = () => {}, opts = {}) {
    const env = buildChildEnv({ backend: this.backend, extraEnv: spec.env });
    const child = spawnSessionLeader(process.execPath, [nativeMockPath(this.mock)], { cwd: spec.cwd, env, scope: spec.scope });
    child.stderr.resume();
    const exited = new Promise(resolve => child.once('close', resolve));

    let open = true;
    let interrupted = false;
    let text = '';
    let tokensUsed = 0;
    let sessionId = '';
    let autoEndTimer;
    let bridge;
    const toolCalls = [];

    const clearAutoEnd = () => { if (autoEndTimer !== undefined) { clearTimeout(autoEndTimer); autoEndTimer = undefined; } };
    const scheduleAutoEnd = () => {
      if (!opts.autoEndAfterFirstTurn || !open) return;
      clearAutoEnd();
      autoEndTimer = setTimeout(() => {
        autoEndTimer = undefined;
        if (open && (opts.shouldAutoEnd?.() ?? true)) session.end();
      }, AUTO_END_DELAY_MS);
      autoEndTimer.unref?.();
    };

    const acp = new AcpSession(
      { input: child.stdin, output: child.stdout },
      {
        backend: this.backend,
        clientInfo: { name: 'ext-acp-plugin', version: '1' },
        onActivity: () => opts.onActivity?.(),
        event: event => {
          if (event.type === 'text') text += event.text;
          if (event.type === 'tool-call') toolCalls.push({ id: event.id, name: event.tool, input: event.input });
          if (event.type === 'token-usage') tokensUsed = event.tokensUsed;
          if (event.type === 'session') sessionId = event.sessionId;
          onEvent(event);
          if (event.type === 'turn-end') {
            if (open) opts.onAgentInputReady?.();
            scheduleAutoEnd();
          }
        },
        uiEvent: event => opts.onUiEvent?.(event),
        hooks: {
          permissionPolicy: request => {
            const allow = request.options.find(option => option.kind === 'allow_once');
            return allow ? { outcome: 'selected', optionId: allow.optionId } : { outcome: 'cancelled' };
          },
        },
      },
    );

    const stopChild = () => {
      if (child.exitCode === null && child.signalCode === null) signalSession(child, 'SIGTERM');
    };

    const result = (async () => {
      try {
        bridge = await startMcpBridge(spec, env);
        await acp.initialize();
        await acp.open({ cwd: spec.cwd, mcpServers: bridge ? [bridge.descriptor] : [] });
        await acp.prompt([{ type: 'text', text: spec.userPrompt }]);
        await exited;
      } finally {
        open = false;
        clearAutoEnd();
        acp.close();
        stopChild();
        await bridge?.close();
      }
      onEvent({ type: 'done' });
      opts.onUiEvent?.({ type: 'session.ended', reason: interrupted ? 'cancelled' : 'end_turn' });
      return { text: text.trim(), toolCalls, tokensUsed, sessionId };
    })();

    const session = {
      result,
      get pid() { return child.pid; },
      get open() { return open; },
      sendMessage(blocks) {
        if (!open) return false;
        clearAutoEnd();
        const content = blocksToAcp(blocks);
        void (acp.promptOpen ? acp.steer(content) : acp.prompt(content)).catch(() => {});
        return true;
      },
      sendAgentMessage(blocks, inputIds) {
        if (!open) return false;
        clearAutoEnd();
        const content = blocksToAcp(blocks);
        const onAck = inputIds?.length ? () => opts.onAgentInputConsumed?.([...inputIds]) : undefined;
        return (acp.promptOpen ? acp.steer(content, onAck) : acp.prompt(content, onAck)).then(() => undefined);
      },
      discardQueuedMessages() {},
      holdsHumanInput: () => false,
      heldHumanInputCount: () => 0,
      end() {
        if (!open) return;
        open = false;
        clearAutoEnd();
        child.stdin.end();
      },
      interrupt() {
        open = false;
        interrupted = true;
        clearAutoEnd();
        acp.close();
        stopChild();
      },
    };
    return session;
  }
}
