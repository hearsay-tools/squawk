import './core/register-all-runners.testkit.ts';
import { BUILT_IN_RUNNER_IDS } from './runners/ids.ts';
import { runnerGolden } from './core/runner-golden.testkit.ts';
import { Home } from './home/home.ts';
import { useTestHome, testHome } from './home/test-home.testkit.ts';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentAccountsPath, workspaceConfigPath } from './paths.ts';
import { loadConfig, updateConfigFile } from './config.ts';
import { loadWorkspaceConfig, mergeWriteWorkspaceConfig } from './workspace/config.ts';
import { loadAgentAccounts, mergeWriteAgentAccounts } from './workspace/agent-accounts.ts';
import { workerAccountBindingSchema } from './delegation/execution-identity.ts';

// The registry-checked decoders of stored settings (planner decision 2026-11-20, option a): a
// process that registered the built-in runners keeps every built-in id where the closed enum kept
// it, and a write after that read keeps it too. An id no runner registered reads as the enum read
// it (dropped or refused); a plugin runner a process did not load is that case, a known step-4
// one-way door the PR body names.

describe('registry-checked stored settings with every built-in registered', () => {
  const originalHome = process.env.CEZ_HOME;
  let homeDir: string;
  let repoRoot: string;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'cez-checked-settings-'));
    useTestHome(Home.sandbox(homeDir));
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-checked-repo-'));
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
  });

  afterEach(() => {
    if (originalHome === undefined) useTestHome(undefined);
    else useTestHome(originalHome ? Home.sandbox(originalHome) : undefined);
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('project config keeps every built-in defaultRunner, and a raw-merge write keeps the file value', async () => {
    for (const id of BUILT_IN_RUNNER_IDS) {
      writeFileSync(join(repoRoot, '.ai/cezar', 'config.json'), JSON.stringify({ defaultRunner: id }), 'utf8');
      expect((await loadConfig(repoRoot, testHome())).defaultRunner, id).toBe(id);
    }
    writeFileSync(join(repoRoot, '.ai/cezar', 'config.json'), JSON.stringify({ defaultRunner: 'pi' }), 'utf8');
    await updateConfigFile(join(repoRoot, '.ai/cezar'), (current) =>
      current.ok ? { write: { ...current.raw, plannerModel: 'haiku' }, result: undefined } : { refuse: undefined });
    expect(JSON.parse(readFileSync(join(repoRoot, '.ai/cezar', 'config.json'), 'utf8')).defaultRunner).toBe('pi');
    expect((await loadConfig(repoRoot, testHome())).defaultRunner).toBe('pi');
  });

  it('workspace config keeps agentDefaults.runner and disabledProviders, and a merge write keeps them', async () => {
    const home = testHome();
    Home.seedBytes(home, workspaceConfigPath(undefined, home), Buffer.from(JSON.stringify({
      agentDefaults: { runner: 'pi' },
      disabledProviders: ['codex', 'omp'],
    })));
    const loaded = await loadWorkspaceConfig(home.workspaceConfig);
    expect(loaded.agentDefaults.runner).toBe('pi');
    expect(loaded.disabledProviders).toEqual(['codex', 'omp']);
    await mergeWriteWorkspaceConfig(() => {}, home);
    const written = JSON.parse(readFileSync(workspaceConfigPath(undefined, home), 'utf8'));
    expect(written.agentDefaults.runner).toBe('pi');
    expect(written.disabledProviders).toEqual(['codex', 'omp']);
    expect((await loadWorkspaceConfig(home.workspaceConfig)).disabledProviders).toEqual(['codex', 'omp']);
  });

  it('agent accounts keep the profile-capable providers, and a merge write keeps their rows', async () => {
    const home = testHome();
    // Only claude, codex and pi carry named accounts (the `supportsProfiles` refine, unchanged by
    // the registry check); opencode and omp rows that refine refuses were refused before it too.
    const rows = [
      { id: 'claude-work', provider: 'claude', configDir: '~/.claude/work', label: 'Work' },
      { id: 'codex-work', provider: 'codex', configDir: '~/codex-work', label: 'Work' },
      { id: 'pi-work', provider: 'pi', configDir: '~/pi-work', label: 'Work' },
    ];
    Home.seedBytes(home, agentAccountsPath(home), Buffer.from(JSON.stringify({ accounts: rows })));
    expect((await loadAgentAccounts(home)).accounts.map((account) => account.provider)).toEqual(['claude', 'codex', 'pi']);
    await mergeWriteAgentAccounts(() => {}, home);
    // The write normalizes each kept row (label/addedAt defaults); the provider choice survives it.
    expect(JSON.parse(readFileSync(agentAccountsPath(home), 'utf8')).accounts.map((row: { provider: string }) => row.provider)).toEqual(['claude', 'codex', 'pi']);
    expect((await loadAgentAccounts(home)).accounts.map((account) => account.id)).toEqual(['claude-work', 'codex-work', 'pi-work']);
  });

  it('worker account bindings parse for every built-in provider and survive their JSON persistence', () => {
    // A runner that carries no named accounts (OpenCode, OMP) writes only its home-less default binding.
    const bindings = BUILT_IN_RUNNER_IDS.map(runner => runnerGolden(runner, 'workerAccountBinding'));
    for (const binding of bindings) {
      const read = workerAccountBindingSchema.parse(JSON.parse(JSON.stringify(binding)));
      expect(read.provider).toBe(binding.provider);
    }
  });
});
