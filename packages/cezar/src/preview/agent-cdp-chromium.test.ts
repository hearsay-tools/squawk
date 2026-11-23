import { testHome } from '../home/test-home.testkit.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { createPreviewCdpSocket } from '../server/preview-cdp-socket.ts';
import { attachUpgradeRouter } from '../server/upgrade-router.ts';
import { previewCdpUrl } from './agent-address.ts';
import { resolveChromium } from './chromium.ts';
import { PreviewHost, type RunContext } from './host.ts';
import { fakeViewer } from './preview.testkit.ts';
import { allowLaunches } from '../test-launch-guard.testkit.ts';

// This file drives a real Chromium on purpose (hearsay-tools/squawk#2369).
allowLaunches('browser');

/**
 * The agent's path to a real Chromium (hearsay-tools/cezarion#784): the CDP proxy route, the host's
 * grant and the DevTools pipe. A raw CDP client stands in for agent-browser and drives the page the
 * owner's pane streams; the pane sees the navigation. Skipped where no Chromium is installed.
 */

// bound: page navigation and the first streamed frame settle on their own events;
// this budget guards a hung browser or stream.
const BUDGET_MS = 30_000;
const bin = resolveChromium(undefined, undefined, undefined, undefined, testHome());

let servers: Server[] = [];
let cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

async function listen(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

/** A CDP client over the agent's socket: commands by id, events by method. */
function agentClient(url: string) {
  const ws = new WebSocket(url);
  let nextId = 0;
  let phase = 'connect';
  type Reply = { result?: unknown; error?: { message: string } };
  const replies = new Map<number, { resolve(msg: Reply): void; reject(error: Error): void }>();
  const waiters = new Set<{ method: string; sessionId: string; resolve(): void; reject(error: Error): void }>();
  let failure: Error | undefined;
  const fail = (error: Error) => {
    failure ??= error;
    for (const reply of replies.values()) reply.reject(failure);
    replies.clear();
    for (const waiter of waiters) waiter.reject(failure);
    waiters.clear();
  };
  ws.on('close', (code, reason) => fail(new Error(`Agent CDP socket closed: ${code} ${reason.toString()}`)));
  ws.on('error', error => fail(error));
  ws.on('message', raw => {
    const msg = JSON.parse(String(raw));
    if (typeof msg.id === 'number') {
      const reply = replies.get(msg.id);
      replies.delete(msg.id);
      reply?.resolve(msg);
      return;
    }
    for (const waiter of waiters) {
      if (waiter.method === msg.method && waiter.sessionId === msg.sessionId) {
        waiters.delete(waiter);
        waiter.resolve();
      }
    }
  });
  const unavailable = () => failure ?? (ws.readyState !== WebSocket.OPEN ? new Error(`Agent CDP socket is not open: state ${ws.readyState}`) : undefined);
  /** Subscribe before the command that causes the event. */
  const next = (method: string, sessionId: string) => new Promise<void>((resolve, reject) => {
    const error = unavailable();
    if (error) return reject(error);
    // bound: Chromium may keep the socket open without emitting the navigation event.
    const timer = setTimeout(() => {
      waiters.delete(waiter);
      reject(new Error(`Waiting for ${method} on ${sessionId}: timed out; socket state ${ws.readyState}`));
    }, 30_000);
    const waiter = { method, sessionId, resolve: () => { clearTimeout(timer); resolve(); }, reject: (error: Error) => { clearTimeout(timer); reject(error); } };
    waiters.add(waiter);
  });
  const opened = new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
    ws.once('close', (code, reason) => reject(new Error(`Opening agent CDP socket: ${code} ${reason.toString()}`)));
  });
  const send = <T>(method: string, params: Record<string, unknown> = {}, sessionId?: string) =>
    new Promise<T>((resolve, reject) => {
      const error = unavailable();
      if (error) return reject(error);
      const id = ++nextId;
      const commandPhase = phase;
      // bound: the proxy can keep its socket open while Chromium stops answering a command.
      const timer = setTimeout(() => {
        replies.delete(id);
        reject(new Error(`${commandPhase}: ${method} timed out after ${BUDGET_MS} ms; socket state ${ws.readyState}`));
      }, BUDGET_MS);
      replies.set(id, {
        reject: error => { clearTimeout(timer); reject(error); },
        resolve: msg => {
          clearTimeout(timer);
          if (msg.error) reject(new Error(`${commandPhase}: ${method}: ${msg.error.message}`));
          else resolve(msg.result as T);
        },
      });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }), error => {
        if (error) fail(error);
      });
    });
  return { ws, opened, send, next, phase: (name: string) => { phase = name; } };
}

it('rejects pending and later commands and events when the agent socket closes', async () => {
  const server = createServer();
  const sockets = new WebSocketServer({ server });
  cleanups.push(() => { for (const socket of sockets.clients) socket.terminate(); sockets.close(); });
  const connected = new Promise<WebSocket>(resolve => sockets.once('connection', resolve));
  const client = agentClient(`ws://127.0.0.1:${await listen(server)}`);
  cleanups.push(() => client.ws.terminate());
  await client.opened;
  const remote = await connected;
  const command = expect(client.send('Page.enable')).rejects.toThrow('1011 renderer stalled');
  const event = expect(client.next('Page.loadEventFired', 'S1')).rejects.toThrow('1011 renderer stalled');
  remote.close(1011, 'renderer stalled');
  await Promise.all([command, event]);
  await expect(client.send('Page.enable')).rejects.toThrow('1011 renderer stalled');
  await expect(client.next('Page.loadEventFired', 'S1')).rejects.toThrow('1011 renderer stalled');
});

it('reports the phase and method when an open socket never answers a command', async () => {
  const server = createServer();
  const sockets = new WebSocketServer({ server });
  cleanups.push(() => { for (const socket of sockets.clients) socket.terminate(); sockets.close(); });
  const client = agentClient(`ws://127.0.0.1:${await listen(server)}`);
  cleanups.push(() => client.ws.terminate());
  await client.opened;
  vi.useFakeTimers();
  try {
    client.phase('list page');
    const rejected = expect(client.send('Target.getTargets')).rejects.toThrow('list page: Target.getTargets timed out after 30000 ms');
    await vi.advanceTimersByTimeAsync(BUDGET_MS);
    await rejected;
    expect(client.ws.readyState).toBe(WebSocket.OPEN);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

describe('the agent drives the real preview browser (hearsay-tools/cezarion#784)', () => {
  it.skipIf(process.platform === 'win32' || !bin)('navigates the page the pane streams, and cannot close the browser', async () => {
    vi.stubEnv('CEZ_PREVIEW', '1');
    const dataDir = mkdtempSync(join(tmpdir(), 'cez-agent-cdp-'));
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
    const appPort = await listen(createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><title>agent app</title><h1>driven by the agent</h1>');
    }));

    const events: Array<Record<string, unknown>> = [];
    const store = { getRun: () => ({ id: 'run-1' }), eventLog: { appendEvent: (_runId: string, event: Record<string, unknown>) => { events.push(event); return event; } } };
    const ctx: RunContext = { runId: 'run-1', title: 'Agent drives', worktreePath: dataDir, dataDir, store: store as unknown as RunContext['store'] };
    const host = new PreviewHost({ home: testHome({ ...process.env, CEZ_PREVIEW_NO_SANDBOX: '1' }), env: { ...process.env, CEZ_PREVIEW_NO_SANDBOX: '1' } });
    // Release waits until the browser and its helpers are gone, so none writes the removed profile.
    cleanups.push(async () => { await host.release('run-1', { deleteProfile: true }); await host.close(); });
    const socket = createPreviewCdpSocket({ host });
    cleanups.push(() => socket.close());
    const cockpit = createServer((_req, res) => res.end());
    attachUpgradeRouter(cockpit, [socket.route]);
    const cockpitPort = await listen(cockpit);

    const grant = host.grantAgent('run-1', () => ctx);
    const agent = agentClient(previewCdpUrl(`http://127.0.0.1:${cockpitPort}`, grant.token)!);
    cleanups.push(() => { agent.ws.terminate(); });
    await agent.opened;

    agent.phase('list and attach page');
    // What agent-browser does on connect: list the pages, attach to the live one.
    const { targetInfos } = await agent.send<{ targetInfos: Array<{ type: string; targetId: string }> }>('Target.getTargets');
    const pages = targetInfos.filter(target => target.type === 'page');
    expect(pages).toHaveLength(1);
    const { sessionId } = await agent.send<{ sessionId: string }>('Target.attachToTarget', { targetId: pages[0]!.targetId, flatten: true });
    await agent.send('Page.enable', {}, sessionId);
    expect(events).toEqual([{ type: 'preview.agent-browser', state: 'connected' }]);

    // The owner opens the agent's page, and watches the agent navigate it.
    const viewer = fakeViewer();
    await host.handle(ctx, viewer, { t: 'open', target: { agent: true } });
    agent.phase('navigate and stream');
    const loaded = agent.next('Page.loadEventFired', sessionId);
    await Promise.all([loaded, agent.send('Page.navigate', { url: `http://127.0.0.1:${appPort}/` }, sessionId)]);
    await vi.waitFor(() => expect(viewer.messages).toContainEqual({ t: 'url', url: `http://127.0.0.1:${appPort}/` }), { timeout: BUDGET_MS, interval: 50 });
    await vi.waitFor(() => expect(viewer.frames.length).toBeGreaterThan(0), { timeout: BUDGET_MS, interval: 50 });
    agent.phase('read document title');
    const { result } = await agent.send<{ result: { value: string } }>('Runtime.evaluate', { expression: 'document.title', returnByValue: true }, sessionId);
    expect(result.value).toBe('agent app');

    // The owner's browser outlives the agent's attempt to close it.
    agent.phase('reject browser close');
    await expect(agent.send('Browser.close')).rejects.toThrow(`Squawk refuses Browser.close`);
    expect(host.ownsBrowser('run-1')).toBe(true);

    // The session ends: its socket closes, and the browser is the pane's alone.
    const closed = new Promise<number>(resolve => agent.ws.once('close', code => resolve(code)));
    grant.revoke();
    expect(await closed).toBe(1008);
    expect(events.at(-1)).toEqual({ type: 'preview.agent-browser', state: 'disconnected' });
    expect(host.ownsBrowser('run-1')).toBe(true);
    host.detach('run-1', viewer);
  }, 240_000);
});
