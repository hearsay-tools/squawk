import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AgentRunSpec } from '../../core/agent-runner.ts';
import { spawnSessionLeader, signalSession } from '../../core/session-process.ts';
import { boundOutputDrainAfterExit } from '../../core/runner-runtime.ts';
import { AcpTransport, AcpRpcError } from '../acp/transport.ts';

/** Antigravity accepts HTTP MCP only. The private stdio command stays caller-owned. */
export async function antigravityMcp(spec: AgentRunSpec, env: NodeJS.ProcessEnv) {
  if (!spec.squawkTools) return undefined;
  const command = spec.squawkTools;
  const child = spawnSessionLeader(command.command, command.args, { cwd: spec.cwd, env, scope: spec.scope, timings: spec.timings });
  boundOutputDrainAfterExit(child);
  const exited = new Promise<void>(resolve => child.once('close', () => resolve()));
  child.stderr.resume();
  const rpc = new AcpTransport({ input: child.stdin, output: child.stdout }, {
    notification: () => {}, request: () => { throw new AcpRpcError(-32601, 'Unsupported client request'); },
  });
  child.on('error', error => rpc.close(error));
  const token = randomUUID();
  const server = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(403).end(); return; }
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    void (async () => {
      let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 1_048_576) throw new Error('MCP request too large'); }
      const frame = z.object({ jsonrpc: z.literal('2.0'), id: z.union([z.number(), z.string()]).optional(), method: z.string(), params: z.unknown().optional() }).parse(JSON.parse(body));
      if (frame.id === undefined) { rpc.notify(frame.method, frame.params); res.writeHead(202).end(); return; }
      let response: unknown;
      try { response = { jsonrpc: '2.0', id: frame.id, result: await rpc.request(frame.method, frame.params) }; }
      catch (error) { const failure = error instanceof AcpRpcError ? error : new AcpRpcError(-32603, 'MCP command unavailable'); response = { jsonrpc: '2.0', id: frame.id, error: { code: failure.code, message: failure.message } }; }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(response));
    })().catch(() => { if (!res.headersSent) res.writeHead(400); res.end(); });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('MCP bridge has no address');
  let closing: Promise<void> | undefined;
  return {
    descriptor: { type: 'http', name: command.name, url: `http://127.0.0.1:${address.port}/mcp`, headers: [{ name: 'Authorization', value: `Bearer ${token}` }] },
    close(): Promise<void> {
      return closing ??= (async () => {
        rpc.close(); server.closeAllConnections(); server.close(); child.stdin.end();
        if (child.exitCode !== null || child.signalCode !== null) return;
        signalSession(child, 'SIGTERM');
        const timer = setTimeout(() => signalSession(child, 'SIGKILL'), spec.timings?.killGraceMs ?? 10_000);
        try { await exited; } finally { clearTimeout(timer); }
      })();
    },
  };
}
