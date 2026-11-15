import { projectPaths } from './project-paths.ts';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { PassThrough, type Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from './runs/store.ts';
import { requirePid } from './pid-file.testkit.ts';

/** Hang guard for the waits below: each ends the moment its condition holds, so the bound only ends a hang. */
const HANG_GUARD_MS = 15_000;

/**
 * Squawk's own SIGINT and SIGTERM reach the agents (hearsay-tools/cezarion#890), through the real CLI.
 *
 * Agent sessions lead their own process groups, so the terminal's Ctrl-C no longer reaches them
 * through Squawk's foreground group. `serve` forwards the signal as it exits, after its store has
 * closed, so the run stays `running` for restart recovery; `cez run` forwards it and still ends
 * by it. Squawk is started in its own group, as a shell starts a foreground job.
 *
 * The agent outlives its stdin: the bundled mock exits when Squawk's exit closes its stdin, which
 * would pass these tests with no forwarding at all. Every probe (`--help`, auth) still goes to
 * the mock; only a session stalls.
 */

const CLI = fileURLToPath(new URL('./index.ts', import.meta.url));
const PACKAGE_DIR = fileURLToPath(new URL('../', import.meta.url));
const MOCK_CLAUDE = fileURLToPath(new URL('../scripts/mock-claude.mjs', import.meta.url));
const STALLING_AGENT = `#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { renameSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (!args.includes('--input-format')) process.exit(spawnSync(process.execPath, [${JSON.stringify(MOCK_CLAUDE)}, ...args], { stdio: 'inherit' }).status ?? 1);
writeFileSync('watchdog.pid.tmp', String(process.pid));
renameSync('watchdog.pid.tmp', 'watchdog.pid');
setInterval(() => {}, 1000);
`;

let root: string;
let cez: ChildProcess | undefined;
const agents: number[] = [];

const env = () => {
  const vars: NodeJS.ProcessEnv = { ...process.env, CEZ_DRY_RUN: '1', CEZ_HOME: join(root, 'home'),
    CEZ_CLAUDE_BIN: join(root, 'stalling-agent.mjs') };
  for (const [key, value] of Object.entries(vars)) {
    if (key.startsWith('CEZ_')) vars[`HSQ_${key.slice(4)}`] = value;
  }
  delete vars.CEZ_AUTOMATIONS;
  delete vars.HSQ_AUTOMATIONS;
  return vars;
};

/** A zombie has exited; only its reaper's wait remains. */
function alive(pid: number): boolean {
  try { process.kill(pid, 0); } catch { return false; }
  if (process.platform !== 'linux') return true;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 1).trim()[0] !== 'Z';
  } catch { return false; }
}

/** The agent, once it stalls in its task worktree. */
async function agentPid(): Promise<number> {
  return vi.waitFor(() => {
    const worktrees = join(projectPaths(root).write, 'worktrees');
    const file = readdirSync(worktrees).map(id => join(worktrees, id, 'watchdog.pid')).find(existsSync);
    expect(file).toBeDefined();
    const pid = requirePid(file!);
    agents.push(pid);
    return pid;
  }, { timeout: 30_000, interval: 100 });
}

async function serve(): Promise<string> {
  cez = spawn(process.execPath, ['--import', 'tsx', CLI, 'serve', '--repo', root, '--port', '0', '--no-open'], {
    cwd: PACKAGE_DIR, env: env(), stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  });
  let stderr = '';
  cez.stderr!.on('data', (chunk) => { stderr += chunk; });
  for await (const line of createInterface({ input: cez.stdout! })) {
    const url = /cockpit → (http:\/\/\S+)/.exec(line)?.[1];
    if (url) { cez.stdout!.resume(); return url; }
  }
  throw new Error(`serve exited before listening: ${stderr}`);
}

async function stalledRun(url: string): Promise<string> {
  const response = await fetch(`${url}/api/v1/runs`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task: 'mock:no-progress', workflow: 'quick-task', runner: 'claude' }),
  });
  expect(response.ok, await response.clone().text()).toBe(true);
  return ((await response.json()) as { id: string }).id;
}

/**
 * Runs argv on a pseudo-terminal as its session leader, then closes the master when `hangup`
 * appears: the kernel hangs up the foreground group, as closing a terminal window does. Relays the
 * child's output, and prints its exit status ("signal N" or "code N") once it ends, without
 * waiting for `hangup` when the child ends first.
 */
const PTY_HOST = `
import os, pty, sys, time, signal
hangup = sys.argv[1]
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[2], sys.argv[2:])
os.set_blocking(fd, False)
def relay():
    try: data = os.read(fd, 65536)
    except (BlockingIOError, OSError): return False
    sys.stdout.buffer.write(data); sys.stdout.buffer.flush()
    return bool(data)
status = None
while status is None and not os.path.exists(hangup):
    done, ended = os.waitpid(pid, os.WNOHANG)
    if done:
        status = ended
        while relay(): pass
    elif not relay(): time.sleep(0.05)
os.close(fd)
if status is None: _, status = os.waitpid(pid, 0)
print('signal %d' % os.WTERMSIG(status) if os.WIFSIGNALED(status) else 'code %d' % os.WEXITSTATUS(status), flush=True)
`;

/**
 * Reads `output` as UTF-8 lines, decoded across chunks. `url` is the URL in the first complete
 * `cockpit →` line, the one `serve` prints once it listens on the port it picked; it rejects with
 * everything read when the output ends first. `last` is the last complete line once it ends.
 */
function bannerUrl(output: Readable): { url: Promise<string>; last: Promise<string> } {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  const lines: string[] = [];
  let found: ((url: string) => void) | undefined;
  const url = new Promise<string>((resolveUrl, reject) => {
    found = resolveUrl;
    output.once('end', () => reject(new Error(`the output ended before serve listened:\n${lines.map((line) => `${line}\n`).join('')}${pending}`)));
  });
  url.catch(() => { /* a caller that never asks for the URL ignores it */ });
  output.on('data', (chunk: Buffer) => {
    pending += decoder.write(chunk);
    for (let end = pending.indexOf('\n'); end >= 0; end = pending.indexOf('\n')) {
      const line = pending.slice(0, end).replace(/\r$/, '');
      pending = pending.slice(end + 1);
      lines.push(line);
      const match = /cockpit → (http:\/\/\S+)/.exec(line)?.[1];
      if (match) found?.(match);
    }
  });
  const last = once(output, 'end').then(() => lines.filter(Boolean).at(-1) ?? '');
  return { url, last };
}

function onPty(args: string[]): { hangUp: () => void; ended: Promise<string>; url: Promise<string> } {
  const hangup = join(root, 'hangup');
  const host = spawn('python3', ['-I', '-c', PTY_HOST, hangup, process.execPath, '--import', 'tsx', CLI, ...args], {
    cwd: PACKAGE_DIR, env: env(), stdio: ['ignore', 'pipe', 'inherit'],
  });
  cez = host;
  const { url, last } = bannerUrl(host.stdout!);
  return { hangUp: () => writeFileSync(hangup, ''), ended: last, url };
}

describe.skipIf(process.platform === 'win32')('Squawk forwards SIGINT and SIGTERM to agent sessions (hearsay-tools/cezarion#890)', () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-session-signal-'));
    execFileSync('git', ['init', '-q', '-b', 'main', root]);
    execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init']);
    writeFileSync(join(root, 'stalling-agent.mjs'), STALLING_AGENT);
    chmodSync(join(root, 'stalling-agent.mjs'), 0o755);
  });

  afterEach(() => {
    if (cez?.pid) try { process.kill(-cez.pid, 'SIGKILL'); } catch { /* gone */ }
    cez = undefined;
    for (const pid of agents.splice(0)) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
    rmSync(root, { recursive: true, force: true });
  });

  it('Ctrl-C on cez serve stops the agent and leaves the run for recovery', async () => {
    const id = await stalledRun(await serve());
    const agent = await agentPid();
    const exited = once(cez!, 'exit');
    process.kill(-cez!.pid!, 'SIGINT'); // the terminal signals the foreground job's group
    await exited;
    await vi.waitFor(() => expect(alive(agent)).toBe(false), { timeout: HANG_GUARD_MS });
    // keepLive: read the run as serve left it, before any reader reconciles a live run as failed.
    const store = RunStore.open(projectPaths(root).write, { keepLive: true });
    try { expect(store.getRun(id)?.status).toBe('running'); } finally { store.close(); }
  }, 60_000);

  it('SIGTERM to cez serve alone stops the agent', async () => {
    await stalledRun(await serve());
    const agent = await agentPid();
    const exited = once(cez!, 'exit');
    process.kill(cez!.pid!, 'SIGTERM'); // `kill <pid>`: no terminal involved
    await exited;
    await vi.waitFor(() => expect(alive(agent)).toBe(false), { timeout: HANG_GUARD_MS });
  }, 60_000);

  it('Ctrl-C on cez run stops the agent and still ends cez by SIGINT', async () => {
    cez = spawn(process.execPath, ['--import', 'tsx', CLI, 'run', 'mock:no-progress', '--repo', root], {
      cwd: PACKAGE_DIR, env: env(), stdio: ['ignore', 'pipe', 'pipe'], detached: true,
    });
    cez.stdout!.resume(); cez.stderr!.resume();
    const agent = await agentPid();
    const exited = once(cez, 'exit');
    process.kill(-cez.pid!, 'SIGINT');
    const [, signal] = await exited;
    expect(signal).toBe('SIGINT');
    await vi.waitFor(() => expect(alive(agent)).toBe(false), { timeout: HANG_GUARD_MS });
  }, 60_000);

  describe('SIGHUP when the terminal closes (hearsay-tools/cezarion#915)', () => {
    const hasPython = (() => { try { execFileSync('python3', ['-c', 'import pty']); return true; } catch { return false; } })();

    it.skipIf(!hasPython)('closing the terminal of cez serve stops the agent and leaves the run for recovery', async () => {
      const terminal = onPty(['serve', '--repo', root, '--port', '0', '--no-open']);
      const url = await terminal.url;
      await vi.waitFor(async () => expect((await fetch(`${url}/api/v1/health`)).ok).toBe(true), { timeout: 30_000, interval: 200 });
      const id = await stalledRun(url);
      const agent = await agentPid();
      terminal.hangUp();
      await terminal.ended;
      await vi.waitFor(() => expect(alive(agent)).toBe(false), { timeout: HANG_GUARD_MS });
      const store = RunStore.open(projectPaths(root).write, { keepLive: true });
      try { expect(store.getRun(id)?.status).toBe('running'); } finally { store.close(); }
    }, 60_000);

    // bound: a hang guard; before the host watched its child, this waited for a hangup no test sends.
    it.skipIf(!hasPython)('a serve that exits before its banner fails the URL wait at once, with its output', async () => {
      const terminal = onPty(['serve', '--bogus-flag']);
      await expect(terminal.url).rejects.toThrow(/before serve listened:[\s\S]*Unknown option '--bogus-flag'/);
      expect(await terminal.ended).toBe('code 1');
    }, 30_000);

    it.skipIf(!hasPython)('closing the terminal of cez run stops the agent and ends cez by SIGHUP', async () => {
      const terminal = onPty(['run', 'mock:no-progress', '--repo', root]);
      const agent = await agentPid();
      terminal.hangUp();
      expect(await terminal.ended).toBe('signal 1');
      await vi.waitFor(() => expect(alive(agent)).toBe(false), { timeout: HANG_GUARD_MS });
    }, 60_000);

    it('nohup cez serve survives a hangup and its agent keeps running', async () => {
      cez = spawn('nohup', [process.execPath, '--import', 'tsx', CLI, 'serve', '--repo', root, '--port', '0', '--no-open'], {
        cwd: PACKAGE_DIR, env: env(), stdio: ['ignore', 'pipe', 'pipe'], detached: true,
      });
      cez.stderr!.resume();
      let url = '';
      for await (const line of createInterface({ input: cez.stdout! })) {
        url = /cockpit → (http:\/\/\S+)/.exec(line)?.[1] ?? '';
        if (url) break;
      }
      cez.stdout!.resume();
      await stalledRun(url);
      const agent = await agentPid();
      process.kill(cez.pid!, 'SIGHUP');
      // bound: negative window. A signal arrives within milliseconds and Node acts on it in the next event-loop turn; 1 s is far longer.
      await new Promise(resolve => setTimeout(resolve, 1_000));
      expect(alive(cez.pid!)).toBe(true);
      expect(alive(agent)).toBe(true);
    }, 60_000);
  });
});

describe('bannerUrl', () => {
  it('reads the URL from a complete line, with the arrow and the port split across chunks', async () => {
    const output = new PassThrough();
    const { url, last } = bannerUrl(output);
    let settled: string | undefined;
    void url.then((value) => { settled = value; });
    const line = Buffer.from('\r\n  cockpit → http://127.0.0.1:43219\r\n');
    const arrow = line.indexOf(Buffer.from('→'));
    const port = line.indexOf(Buffer.from(':43')) + 3;
    output.write(line.subarray(0, arrow + 1));
    output.write(line.subarray(arrow + 1, port));
    await new Promise(setImmediate);
    // ":43" ends this chunk: the line is not complete, so no URL yet.
    expect(settled).toBeUndefined();
    output.write(line.subarray(port));
    expect(await url).toBe('http://127.0.0.1:43219');
    output.end('code 0\n');
    expect(await last).toBe('code 0');
  });

  it('rejects with the output read when it ends before the banner', async () => {
    const output = new PassThrough();
    const { url } = bannerUrl(output);
    output.end('Unknown option\n  cockpit → http://127.0.0.1:43');
    await expect(url).rejects.toThrow(/before serve listened:\nUnknown option\n {2}cockpit → http:\/\/127\.0\.0\.1:43$/);
  });
});
