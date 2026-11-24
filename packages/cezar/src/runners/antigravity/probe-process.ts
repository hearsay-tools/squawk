import { rm } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { spawnSessionLeader, signalSession, SessionDescendants } from '@hearsay-tools/squawk/plugin';
import { AcpSession } from './acp/session.ts';
import { antigravityEnv } from './runtime-env.ts';
import type { AcpHooks } from './acp/protocol.ts';
import { antigravityLaunchArgs } from './launch-args.ts';
import { logAntigravityFailure } from './native-diagnostics.ts';
import { ANTIGRAVITY_MISSING, launchAntigravity, missingAntigravity, type AntigravityLaunch } from './executable.ts';

/** Short-lived authentication/catalog process. No prompt or tools; bounded stderr stays in memory. */
export class AntigravityProbe {
  readonly acp: AcpSession;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  private readonly geminiDir: string;
  private readonly launch: AntigravityLaunch;
  private readonly child;
  private readonly descendants;
  private readonly exited: Promise<void>;
  private readonly deadline: NodeJS.Timeout;
  private closing: Promise<void> | undefined;
  private stderr = '';
  private spawnError: Error | undefined;
  private signalled = false;

  /** `bin` is HSQ_ANTIGRAVITY_BIN when set; otherwise the managed install is leased, or PATH is used. */
  constructor(bin: string | undefined, env: Record<string, string>, timeoutMs: number, hooks: AcpHooks = {}) {
    const runtime = antigravityEnv({ env });
    this.cwd = runtime.temp; this.env = runtime.env; this.geminiDir = runtime.geminiDir;
    this.launch = launchAntigravity(bin) ?? missingAntigravity(this.cwd);
    try {
      this.child = spawnSessionLeader(this.launch.executable, antigravityLaunchArgs(this.geminiDir), { cwd: this.cwd, env: this.env });
      if (this.child.pid) this.launch.bindProcess(this.child.pid);
    } catch (error) { this.launch.release(); rmSync(this.cwd, { recursive: true, force: true }); throw error; }
    this.descendants = new SessionDescendants(this.child);
    this.acp = new AcpSession({ input: this.child.stdin, output: this.child.stdout }, {
      backend: 'antigravity', clientInfo: { name: 'squawk-discovery', version: '1' },
      hooks,
    });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-32_768); });
    this.child.on('error', error => {
      this.spawnError = (error as NodeJS.ErrnoException).code === 'ENOENT' ? new Error(ANTIGRAVITY_MISSING) : error;
      this.acp.transport.close(error);
    });
    this.exited = new Promise(resolve => this.child.once('close', () => resolve()));
    this.deadline = setTimeout(() => { void this.close(new Error(`Probe timed out after ${timeoutMs}ms`)).catch(() => {}); }, timeoutMs);
    this.deadline.unref();
  }

  close(failure?: unknown): Promise<void> { return this.closing ??= this.shutdown(failure); }

  get diagnostics() {
    return { code: this.child.exitCode, signal: this.signalled ? null : this.child.signalCode, stderr: this.stderr, spawnError: this.spawnError };
  }

  private async shutdown(failure?: unknown): Promise<void> {
    clearTimeout(this.deadline);
    this.descendants.capture();
    this.acp.close(); this.child.stdin.end();
    const term = setTimeout(() => { this.signalled = true; signalSession(this.child, 'SIGTERM'); }, 100);
    const kill = setTimeout(() => { this.signalled = true; signalSession(this.child, 'SIGKILL'); }, 1000);
    this.descendants.terminate(100);
    try { await this.exited; }
    finally {
      clearTimeout(term); clearTimeout(kill);
      try { this.launch.release(); } catch { /* Pruning drops a lease whose owner process has exited. */ }
      if (failure !== undefined) await logAntigravityFailure(this.geminiDir, this.child.pid, 'probe', failure, this.env, this.stderr);
      await rm(this.cwd, { recursive: true, force: true });
    }
  }
}
