import { fixedSkillCatalog } from './core/runner-skill-fixture.testkit.ts';
import { Home } from './home/home.ts';
import { useTestHome } from './home/test-home.testkit.ts';
import { testHome } from './home/test-home.testkit.ts';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRunner } from './core/agent-runner.ts';
import { planChain } from './planner.ts';
import { registerRunner } from './core/runner-registry.ts';
import { ompRunner } from './runners/omp/definition.ts';

registerRunner(ompRunner);

const run = vi.fn(async () => ({ text: '' }));
async function runners(): Promise<AgentRunner> {
  return { run } as unknown as AgentRunner;
}

describe('planChain skill catalog', () => {
  let home: string;
  let repoRoot: string;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'cez-planner-account-home-')));
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), 'cez-planner-account-repo-')));
    useTestHome(home ? Home.sandbox(home) : undefined);
    for (const key of ['OMP_PROFILE', 'PI_PROFILE', 'PI_CONFIG_DIR', 'PI_CODING_AGENT_DIR']) vi.stubEnv(key, undefined);
    // The discovered omp home follows these, so the host's values must not reach the plan.
    vi.stubEnv('HOME', join(home, 'user'));
    mkdirSync(join(repoRoot, '.ai', 'cezar'), { recursive: true });
    writeFileSync(join(repoRoot, '.ai', 'cezar', 'config.json'), JSON.stringify({ defaultRunner: 'omp' }), 'utf8');
    run.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const dir of [home, repoRoot]) rmSync(dir, { recursive: true, force: true });
  });

  it('omits ambiguous skill ids from the prompt and strips them from the returned plan', async () => {
    const catalog = fixedSkillCatalog([
      { id: 'duplicate', name: 'Duplicate', description: 'AMBIGUOUS-CATALOG-ENTRY', scope: 'repo', path: '/one/SKILL.md' },
      { id: 'duplicate', name: 'Duplicate', description: 'AMBIGUOUS-CATALOG-ENTRY', scope: 'repo', path: '/two/SKILL.md' },
      { id: 'unique', name: 'Unique', description: 'UNIQUE-CATALOG-ENTRY', scope: 'repo', path: '/unique/SKILL.md' },
    ]);
    run.mockResolvedValueOnce({ text: JSON.stringify({ title: 'Plan', steps: [{ skill: 'duplicate', name: 'Inspect', prompt: 'Inspect the code' }], rationale: 'Inspect first' }) });
    const plan = await planChain(repoRoot, 'do it', catalog, testHome(), runners);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ userPrompt: expect.stringContaining('UNIQUE-CATALOG-ENTRY') }));
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ userPrompt: expect.not.stringContaining('AMBIGUOUS-CATALOG-ENTRY') }));
    expect(plan.steps[0]?.skill).toBeUndefined();
  });

});
