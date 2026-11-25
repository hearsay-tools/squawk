import { BUILT_IN_RUNNER_IDS } from './built-in-runner-ids.testkit.ts';
import '../core/register-all-runners.testkit.ts';
import { type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { spawnSessionLeader } from './session-process.ts';
import { tmpdir } from 'node:os';
import { describe, it, expect } from 'vitest';
import { profileEnv } from './agent-profiles.ts';
import { runnerDefinition } from './runner-registry.ts';
import { RunnerSkillCatalog, type SkillCatalogQuery } from './runner-skill-catalog.ts';
import { skillProbe, type SkillDiscoveryOptions } from './skill-probe.ts';
import { ignoreTermSource } from '../stubborn-child.testkit.ts';

// Every case runs over each runner id; the probe builds each one's child env through the registry.
// The member reports readiness after installing its handlers; only then does its leader crash.
const leaderFirst = `const { spawn } = require('node:child_process');
const member = spawn(process.execPath, ['-e', ${JSON.stringify(`${ignoreTermSource()} setInterval(() => {}, 1000); process.send('ready')`)}],
  { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
member.once('message', () => process.exit(1));`;

for (const runner of BUILT_IN_RUNNER_IDS) describe(`${runner} skill probe process cleanup`, () => {
  // Windows uses taskkill trees; leaderless POSIX process groups do not exist there.
  for (const failure of ['hung', 'crashed', 'leader-first'] as const) it.runIf(failure !== 'leader-first' || process.platform !== 'win32')(`${failure}: unavailable with a reason and no child left`, async () => {
    let child!: ChildProcessWithoutNullStreams;
    let exit!: Promise<unknown>;
    const launch: SkillDiscoveryOptions['spawn'] = (_bin, args, cwd, env) => {
      if (runner === 'antigravity') {
        expect(env.GEMINI_HOME).toBe('/profiles/probe');
        expect(env.GOOGLE_GEMINI_BASE_URL).toBe('http://127.0.0.1:1');
        expect(args).toContain('--print=/skills');
        expect(args).toContain('stream-json');
      } else {
        expect(env).toMatchObject(profileEnv(runner, '/profiles/probe'));
      }
      if (runner === 'claude') {
        expect(args).toContain('--no-session-persistence');
        expect(args[args.indexOf('--settings') + 1]).toBe('{"disableAllHooks":true}');
        expect(args).not.toContain('--safe-mode');
        expect(args).toContain('--strict-mcp-config');
      }
      if (runner === 'pi') expect(args.some(a => a.endsWith('/pi-project-skills.mjs'))).toBe(true);
      child = spawnSessionLeader(process.execPath, ['-e', failure === 'hung'
        ? `${ignoreTermSource()} setInterval(() => {}, 1000)`
        : failure === 'leader-first' ? leaderFirst : 'process.exit(1)'], { cwd, env });
      exit = once(child, 'exit');
      return child;
    };
    // Loaded before the catalog's deadline starts, so its first import cannot use it up.
    const discoverSkills = await runnerDefinition(runner).loadSkillCatalog();
    const catalog = new RunnerSkillCatalog({ timeoutMs: failure === 'hung' ? 200 : 4000, adapters: { [runner]: {
      discover: (q: SkillCatalogQuery, signal: AbortSignal) => discoverSkills({ ...q, spawn: launch, timeoutMs: 3000, signal }),
    } } });
    // Real child exit and OS process-group reaping require the product's exit signal.
    const result = await catalog.get({ runner, cwd: tmpdir(), accountHome: '/profiles/probe' });
    expect(result).toMatchObject({ source: 'unavailable', reason: expect.any(String) });
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    if (failure !== 'hung') expect(child.exitCode).toBe(1);
    // Check immediately on return; waiting for the exit here would hide the catalog race.
    const target = process.platform === 'win32' ? child.pid! : -child.pid!;
    expect(() => process.kill(target, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
    await exit;
  }, 5000); // bound: a 200ms catalog deadline plus bounded cleanup must reap its group; a crash gets 3 seconds to start.
});

describe.runIf(process.platform !== 'win32')('leader-first probe cleanup on every outcome', () => {
  it.each(['success', 'read-failure', 'abort'] as const)('%s waits for the whole group', async outcome => {
    let child!: ChildProcessWithoutNullStreams;
    const controller = new AbortController();
    const probe = skillProbe('claude', [], { cwd: tmpdir(), signal: controller.signal, spawn: (_bin, _args, cwd, env) => {
      child = spawnSessionLeader(process.execPath, ['-e', leaderFirst.replace('exit(1)', 'exit(0)')], { cwd, env });
      return child;
    } }, async child => {
      await once(child, 'exit');
      if (outcome === 'read-failure') throw new Error('read failed');
      if (outcome === 'abort') controller.abort();
      return 'metadata';
    });
    if (outcome === 'success') expect(await probe).toBe('metadata');
    else await expect(probe).rejects.toThrow(outcome === 'abort' ? 'cancelled' : 'read failed');
    expect(() => process.kill(-child.pid!, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
  }, 5000); // bound: two mock processes start, then the probe waits at most 750ms for group disappearance.

  it('reaps the live child process group when onSpawn throws', async () => {
    let child!: ChildProcessWithoutNullStreams;
    const probe = skillProbe('claude', [], {
      cwd: tmpdir(),
      spawn: (_bin, _args, cwd, env) => {
        child = spawnSessionLeader(process.execPath, ['-e', `${ignoreTermSource()} setInterval(() => {}, 1000)`], { cwd, env });
        return child;
      },
    }, async () => 'metadata', {
      onSpawn: () => { throw new Error('lease bind failed'); },
    });
    await expect(probe).rejects.toThrow('lease bind failed');
    expect(() => process.kill(-child.pid!, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
  }, 5000); // bound: child starts, onSpawn throws, and cleanup kills and reaps the group.
});
