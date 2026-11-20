import { BUILT_IN_RUNNER_IDS } from './runners/ids.ts';
import './core/register-all-runners.testkit.ts';
import { fixedSkillCatalog } from './core/runner-skill-fixture.testkit.ts';
import { Home } from './home/home.ts';
import { testHome, useTestHome } from './home/test-home.testkit.ts';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type AgentRunner } from './core/agent-runner.ts';
import { planChain } from './planner.ts';
import { generateRunName } from './runs/auto-name.ts';


const run = vi.fn(async () => ({ text: '' }));
const runners = async (): Promise<AgentRunner> => ({ run }) as unknown as AgentRunner;

/** `plannerModel` and `namerModel` are Claude model aliases: only the Claude runner gets them. */
const EXPECTED: Record<string, { planner: string | undefined; namer: string | undefined }> = {
  claude: { planner: 'sonnet', namer: 'haiku' },
  codex: { planner: undefined, namer: undefined },
  opencode: { planner: undefined, namer: undefined },
  pi: { planner: undefined, namer: undefined },
  omp: { planner: undefined, namer: undefined },
};

describe('planner and namer model presets per default runner', () => {
  let home: string;
  let repoRoot: string;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'cez-model-presets-home-')));
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), 'cez-model-presets-repo-')));
    useTestHome(Home.sandbox(home));
    vi.stubEnv('HOME', join(home, 'user'));
    vi.stubEnv('CEZ_DRY_RUN', undefined);
    vi.stubEnv('HSQ_DRY_RUN', undefined);
    run.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const dir of [home, repoRoot]) rmSync(dir, { recursive: true, force: true });
  });

  function useDefaultRunner(runner: string): void {
    mkdirSync(join(repoRoot, '.ai', 'cezar'), { recursive: true });
    writeFileSync(join(repoRoot, '.ai', 'cezar', 'config.json'), JSON.stringify({ defaultRunner: runner }), 'utf8');
  }

  it.each(BUILT_IN_RUNNER_IDS)('plans on %s with its preset model or none', async (runner) => {
    useDefaultRunner(runner);
    await planChain(repoRoot, 'do it', fixedSkillCatalog(), testHome(), runners);
    expect(run).toHaveBeenCalled();
    for (const [spec] of run.mock.calls as unknown as Array<[{ model?: string }]>) expect(spec.model).toBe(EXPECTED[runner]!.planner);
  });

  it.each(BUILT_IN_RUNNER_IDS)('names on %s with its preset model or none', async (runner) => {
    useDefaultRunner(runner);
    await generateRunName(repoRoot, { task: 'rename the settings page' }, testHome(), runners);
    expect(run).toHaveBeenCalled();
    for (const [spec] of run.mock.calls as unknown as Array<[{ model?: string }]>) expect(spec.model).toBe(EXPECTED[runner]!.namer);
  });
});
