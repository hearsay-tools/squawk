import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../config.ts';
import { runnersSealed } from '../core/runner-registry.ts';
import { Home } from '../home/home.ts';
import { testHome, useTestHome } from '../home/test-home.testkit.ts';
import { workspaceConfigPath } from '../paths.ts';
import { loadWorkspaceConfig, mergeWriteWorkspaceConfig } from './config.ts';

/**
 * The sibling suite seals the runner registry at import, so it cannot exercise stored-config
 * reads before `bootRuntime()` seals the registry (hearsay-tools/squawk#4233). This file never
 * seals at module scope.
 */
describe('workspace and repo config before the runner registry is sealed', () => {
  const originalHome = process.env.CEZ_HOME;
  let home: string;
  let repoRoot: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cez-config-unsealed-home-'));
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-config-unsealed-repo-'));
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    useTestHome(Home.sandbox(home));
  });

  afterEach(() => {
    if (originalHome === undefined) useTestHome(undefined);
    else useTestHome(Home.sandbox(originalHome));
    rmSync(home, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const writeWorkspace = (value: unknown) =>
    Home.seedBytes(testHome(), workspaceConfigPath(undefined, testHome()), Buffer.from(JSON.stringify(value)));

  const project = {
    id: 'shop',
    root: '/tmp/projects/shop',
    name: 'shop',
    addedAt: '',
    lastOpenedAt: '',
    source: 'local' as const,
  };

  it('loads stored agentDefaults, disabledProviders and projects without treating the file as corrupt', async () => {
    expect(runnersSealed()).toBe(false);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    writeWorkspace({
      agentDefaults: {
        runner: 'codex',
        models: { claude: 'opus', codex: 'gpt-5', ghost: 'gpt-x' },
      },
      disabledProviders: ['codex', 'ghost'],
      projects: [project],
    });

    const config = await loadWorkspaceConfig(testHome().workspaceConfig);
    expect(config.agentDefaults).toEqual({
      runner: 'codex',
      models: { claude: 'opus', codex: 'gpt-5', ghost: 'gpt-x' },
    });
    expect(config.disabledProviders).toEqual(['codex', 'ghost']);
    expect(config.projects).toEqual([project]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('preserves stored agentDefaults and disabledProviders across an unsealed merge-write', async () => {
    expect(runnersSealed()).toBe(false);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    writeWorkspace({
      agentDefaults: {
        runner: 'codex',
        models: { claude: 'opus', ghost: 'gpt-x' },
      },
      disabledProviders: ['opencode', 'ghost'],
      projects: [project],
    });

    await mergeWriteWorkspaceConfig((config) => {
      config.projectsDir = '/tmp/other-projects';
    }, testHome());

    const raw = JSON.parse(readFileSync(workspaceConfigPath(undefined, testHome()), 'utf8')) as {
      agentDefaults: unknown;
      disabledProviders: string[];
      projects: unknown[];
      projectsDir: string;
    };
    expect(raw.agentDefaults).toEqual({
      runner: 'codex',
      models: { claude: 'opus', ghost: 'gpt-x' },
    });
    expect(raw.disabledProviders).toEqual(['opencode', 'ghost']);
    expect(raw.projects).toEqual([project]);
    expect(raw.projectsDir).toBe('/tmp/other-projects');
    expect(warn).not.toHaveBeenCalled();
  });

  it('loads repo defaultRunner and defaultModels merged with workspace agentDefaults before seal', async () => {
    expect(runnersSealed()).toBe(false);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    writeWorkspace({
      agentDefaults: {
        runner: 'codex',
        models: { claude: 'opus', ghost: 'gpt-x' },
      },
    });
    writeFileSync(
      join(repoRoot, '.ai/cezar/config.json'),
      JSON.stringify({ defaultRunner: 'ghost', defaultModels: { codex: 'o3' } }),
      'utf8',
    );

    const config = await loadConfig(repoRoot, testHome());
    expect(config.defaultRunner).toBe('ghost');
    expect(config.defaultModels).toEqual({ claude: 'opus', ghost: 'gpt-x', codex: 'o3' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps stored settings even after a runner is registered before seal', async () => {
    vi.resetModules();
    const { registerRunner, runnersSealed: isSealed } = await import('../core/runner-registry.ts');
    const { claudeRunner } = await import('../runners/claude/definition.ts');
    const { loadWorkspaceConfig: loadUnsealed, mergeWriteWorkspaceConfig: mergeUnsealed } = await import('./config.ts');
    registerRunner(claudeRunner);
    expect(isSealed()).toBe(false);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    writeWorkspace({
      agentDefaults: { runner: 'claude', models: { claude: 'opus', ghost: 'gpt-x' } },
      disabledProviders: ['claude', 'ghost'],
    });

    const loaded = await loadUnsealed(testHome().workspaceConfig);
    expect(loaded.agentDefaults).toEqual({ runner: 'claude', models: { claude: 'opus', ghost: 'gpt-x' } });
    expect(loaded.disabledProviders).toEqual(['claude', 'ghost']);
    await mergeUnsealed((config) => {
      config.projectsDir = '/tmp/partial-unsealed';
    }, testHome());
    const raw = JSON.parse(readFileSync(workspaceConfigPath(undefined, testHome()), 'utf8')) as {
      agentDefaults: unknown;
      disabledProviders: string[];
      projectsDir: string;
    };
    expect(raw.agentDefaults).toEqual({ runner: 'claude', models: { claude: 'opus', ghost: 'gpt-x' } });
    expect(raw.disabledProviders).toEqual(['claude', 'ghost']);
    expect(raw.projectsDir).toBe('/tmp/partial-unsealed');
    expect(warn).not.toHaveBeenCalled();
  });
});
