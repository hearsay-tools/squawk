import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runnersSealed } from '../core/runner-registry.ts';
import { Home } from '../home/home.ts';
import { testHome, useTestHome } from '../home/test-home.testkit.ts';
import { agentAccountsPath, workspaceConfigPath } from '../paths.ts';
import { loadAgentAccounts, mergeWriteAgentAccounts } from './agent-accounts.ts';

/**
 * The sibling suite seals the runner registry at import, so it cannot show a decode that runs
 * before the process entry seals. This file never seals. Stored accounts, selections and legacy
 * defaults must load and survive merge-writes without being treated as corrupt.
 */
describe('agent accounts before the runner registry is sealed', () => {
  const originalHome = process.env.CEZ_HOME;
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cez-accounts-unsealed-'));
    useTestHome(home ? Home.sandbox(home) : undefined);
  });

  afterEach(() => {
    if (originalHome === undefined) useTestHome(undefined);
    else useTestHome(originalHome ? Home.sandbox(originalHome) : undefined);
    rmSync(home, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const write = (value: unknown) =>
    Home.seedBytes(testHome(), agentAccountsPath(testHome()), Buffer.from(JSON.stringify(value)));

  it('keeps stored accounts and selections without warning or throwing', async () => {
    expect(runnersSealed()).toBe(false);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    write({
      accounts: [
        { id: 'work', provider: 'claude', configDir: '~/.claude-work', label: 'work' },
        { id: 'ghost-work', provider: 'ghost', configDir: '~/.ghost-work', label: 'ghost-work' },
      ],
      selections: {
        '/repo': { claude: 'work', ghost: 'ghost-work' },
      },
    });
    const store = await loadAgentAccounts(testHome());
    expect(store.accounts.map((row) => ({ id: row.id, provider: row.provider }))).toEqual([
      { id: 'work', provider: 'claude' },
      { id: 'ghost-work', provider: 'ghost' },
    ]);
    expect(store.selections).toEqual({
      '/repo': { claude: 'work', ghost: 'ghost-work' },
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('preserves stored accounts and selections across an unsealed merge-write', async () => {
    expect(runnersSealed()).toBe(false);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    write({
      accounts: [
        { id: 'work', provider: 'claude', configDir: '~/.claude-work', label: 'work' },
        { id: 'ghost-work', provider: 'ghost', configDir: '~/.ghost-work', label: 'ghost-work' },
      ],
      selections: {
        '/repo': { claude: 'work', ghost: 'ghost-work' },
      },
    });
    await mergeWriteAgentAccounts((store) => {
      store.selections['/other'] = { codex: 'side' };
    }, testHome());
    const raw = JSON.parse(readFileSync(agentAccountsPath(testHome()), 'utf8')) as {
      accounts: { id: string; provider: string; configDir: string }[];
      selections: Record<string, Record<string, string>>;
    };
    expect(raw.accounts.map(({ id, provider, configDir }) => ({ id, provider, configDir }))).toEqual([
      { id: 'work', provider: 'claude', configDir: '~/.claude-work' },
      { id: 'ghost-work', provider: 'ghost', configDir: '~/.ghost-work' },
    ]);
    expect(raw.selections).toEqual({
      '/repo': { claude: 'work', ghost: 'ghost-work' },
      '/other': { codex: 'side' },
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps legacy saved defaults untouched until a booted process seals the registry', async () => {
    expect(runnersSealed()).toBe(false);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    Home.seedBytes(testHome(), workspaceConfigPath(undefined, testHome()), Buffer.from(JSON.stringify({
      schemaVersion: 1,
      projects: [{ id: 'repo', root: '/repo', name: 'repo', addedAt: '', lastOpenedAt: '', source: 'local' }],
    })));
    write({
      accounts: [{ id: 'work', provider: 'claude', configDir: '~/.claude-work', label: 'work' }],
      defaults: { claude: 'work' },
      selections: { '/repo': { ghost: 'ghost-work' } },
    });

    const loaded = await loadAgentAccounts(testHome());
    expect(loaded.selections).toEqual({ '/repo': { ghost: 'ghost-work' } });
    await mergeWriteAgentAccounts(() => {}, testHome());
    const raw = JSON.parse(readFileSync(agentAccountsPath(testHome()), 'utf8')) as Record<string, unknown>;
    expect(raw.defaults).toEqual({ claude: 'work' });
    expect(raw.selections).toEqual({ '/repo': { ghost: 'ghost-work' } });
    expect(warn).not.toHaveBeenCalled();
  });
});
