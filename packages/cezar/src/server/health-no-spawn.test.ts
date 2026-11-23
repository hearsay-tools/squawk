import '../built-in-wait-kinds.testkit.ts';
import { sealTestRunners } from '../core/runner-registry.testkit.ts';
import { ChildProcess, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { BackendCheck } from '../core/backend-detect.ts';
import { runGit } from '../git-command.ts';
import { testHome } from '../home/test-home.testkit.ts';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { HEALTH_TTL_MS } from './health-cache.ts';
import { BACKEND_MAX_AGE_MS } from './backend-checks.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';
import { claudeRunner } from '../runners/claude/definition.ts';

// The environment stamp reads each registered runner's binary, as the live server does.

sealTestRunners(claudeRunner);

/** Hang guard for the cold detection below: the wait ends the moment its checks arrive. */
const HANG_GUARD_MS = 15_000;

const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' });

// hearsay-tools/squawk#3658: each process start forks the server process and blocks its loop until
// the child execs. With no Git or CLI change, a health refresh reads file metadata only.
it('starts no process on a health refresh while nothing changed, and still shows a branch switch', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cez-health-spawn-')); roots.push(root);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'commit', '--allow-empty', '-q', '-m', 'init');
  git(root, 'remote', 'add', 'origin', 'https://github.com/acme/demo.git');
  // A detection that starts a process, as the real one does for every CLI.
  const detectEnvironment = vi.fn(async (): Promise<BackendCheck[]> => {
    const { stdout } = await runGit(['--version']);
    return [{ name: 'git', available: true, version: stdout.trim() }];
  });
  // Before the app: its gates read the clock, and the ticks below must reach them.
  vi.useFakeTimers({ toFake: ['Date'] });
  const app = createApp({ home: testHome(), repoRoot: root, store: RunStore.open(join(root, '.ai/cezar')), manager: {} as RunManager, version: 'test', detectEnvironment });
  const health = async () => await (await apiRequest(app, '/api/v1/health')).json() as { checks: BackendCheck[]; repo: { branch: string } };

  await health();
  await vi.waitFor(async () => expect((await health()).checks).toHaveLength(1), { timeout: HANG_GUARD_MS });

  const spawn = vi.spyOn(ChildProcess.prototype as unknown as { spawn(options: unknown): void }, 'spawn');
  for (let tick = 0; tick < 3; tick++) {
    vi.setSystemTime(Date.now() + HEALTH_TTL_MS + 1);
    expect(await health()).toMatchObject({ repo: { branch: 'main' }, checks: [{ name: 'git', available: true }] });
  }
  expect(spawn.mock.calls.map(([options]) => (options as { args: string[] }).args.join(' '))).toEqual([]);
  expect(detectEnvironment).toHaveBeenCalledOnce();

  git(root, 'checkout', '-q', '-b', 'moved');
  vi.setSystemTime(Date.now() + HEALTH_TTL_MS + 1);
  expect((await health()).repo.branch).toBe('moved');

  // The simulated clock reaches the detection gate: at its age ceiling it detects again.
  vi.setSystemTime(Date.now() + BACKEND_MAX_AGE_MS);
  await health();
  expect(detectEnvironment).toHaveBeenCalledTimes(2);
});
