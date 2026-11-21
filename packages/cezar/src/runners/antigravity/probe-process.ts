import { rm } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { spawnSessionLeader, signalSession } from '../../core/session-process.ts';
import { SessionDescendants } from '../../core/session-descendants.ts';
import { AcpSession } from '../acp/session.ts';
import { antigravityEnv } from './runtime-env.ts';
import type { AcpHooks } from '../acp/protocol.ts';

/** Short-lived authentication/catalog process. No prompt, tools, or retained wire/stderr. */
export class AntigravityProbe {
  readonly acp: AcpSession;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  private readonly child;
  private readonly descendants;
  private readonly exited: Promise<void>;
  private readonly deadline: NodeJS.Timeout;
  private closing: Promise<void> | undefined;

  constructor(bin: string, env: Record<string, string>, timeoutMs: number, hooks: AcpHooks = {}) {
    const runtime = antigravityEnv(bin, { cwd: process.cwd(), userPrompt: '', toolGrant: { kind: 'unset' }, env });
    this.cwd = runtime.temp; this.env = runtime.env;
    try { this.child = spawnSessionLeader(bin, ['--uid='], { cwd: this.cwd, env: this.env }); }
    catch (error) { rmSync(this.cwd, { recursive: true, force: true }); throw error; }
    this.descendants = new SessionDescendants(this.child);
    this.acp = new AcpSession({ input: this.child.stdin, output: this.child.stdout }, {
      backend: 'antigravity', clientInfo: { name: 'squawk-discovery', version: '1' },
      hooks: { ...hooks, sessionParams: () => ({ _meta: { antigravity: { disabledTools: ['run_workflow'] } } }) },
    });
    this.child.stderr.resume();
    this.child.on('error', () => this.acp.close());
    this.exited = new Promise(resolve => this.child.once('close', () => resolve()));
    this.deadline = setTimeout(() => { void this.close().catch(() => {}); }, timeoutMs);
    this.deadline.unref();
  }

  close(): Promise<void> { return this.closing ??= this.shutdown(); }

  private async shutdown(): Promise<void> {
    clearTimeout(this.deadline);
    this.descendants.capture();
    this.acp.close(); this.child.stdin.end();
    const term = setTimeout(() => signalSession(this.child, 'SIGTERM'), 100);
    const kill = setTimeout(() => signalSession(this.child, 'SIGKILL'), 1000);
    this.descendants.terminate(100);
    try { await this.exited; }
    finally {
      clearTimeout(term); clearTimeout(kill);
      await rm(this.cwd, { recursive: true, force: true });
    }
  }
}
