import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { describe, it, expect } from 'vitest';
import { RUNNER_IDS } from './agent-runner.ts';
import { profileEnv } from './agent-profiles.ts';
import { discoverClaudeSkills } from './claude-skill-catalog.ts';
import { discoverCodexSkills } from './codex-skill-catalog.ts';
import { discoverOpencodeSkills } from './opencode-skill-catalog.ts';
import { discoverPiSkills } from './pi-skill-catalog.ts';
import { discoverOmpSkills } from './omp-skill-catalog.ts';
import { RunnerSkillCatalog, type SkillCatalogQuery } from './runner-skill-catalog.ts';
import type { SkillDiscoveryOptions } from './skill-probe.ts';
const discovers = { claude: discoverClaudeSkills, codex: discoverCodexSkills, opencode: discoverOpencodeSkills, pi: discoverPiSkills, omp: discoverOmpSkills };

for (const runner of RUNNER_IDS) describe(`${runner} skill probe process cleanup`, () => {
  for (const failure of ['hung', 'crashed'] as const) it(`${failure}: unavailable with a reason and no child left`, async () => {
    let child!: ChildProcessWithoutNullStreams;
    let exit!: Promise<unknown>;
    const launch: SkillDiscoveryOptions['spawn'] = (_bin, args, cwd, env) => {
      expect(env).toMatchObject(profileEnv(runner, '/profiles/probe'));
      if (runner === 'claude') {
        expect(args).toContain('--no-session-persistence');
        expect(args[args.indexOf('--settings') + 1]).toBe('{"disableAllHooks":true}');
        expect(args).not.toContain('--safe-mode');
        expect(args).toContain('--strict-mcp-config');
      }
      if (runner === 'pi') expect(args.some(a => a.endsWith('/pi-project-skills.mjs'))).toBe(true);
      child = spawn(process.execPath, ['-e', failure === 'hung'
        ? "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"
        : 'process.exit(1)'], { cwd, env });
      exit = once(child, 'exit');
      return child;
    };
    const catalog = new RunnerSkillCatalog({ timeoutMs: 4000, adapters: { [runner]: {
      discover: (q: SkillCatalogQuery, signal: AbortSignal) => discovers[runner]({ ...q, spawn: launch, timeoutMs: failure === 'hung' ? 200 : 3000, signal }),
    } } });
    const result = await catalog.get({ runner, cwd: tmpdir(), accountHome: '/profiles/probe' });
    expect(result).toMatchObject({ source: 'unavailable', reason: expect.any(String) });
    await exit;
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    if (failure === 'crashed') expect(child.exitCode).toBe(1);
    expect(() => process.kill(child.pid!, 0)).toThrow();
  }, 5000); // bound: a 200ms probe must reap its process even when it ignores SIGTERM.
});
