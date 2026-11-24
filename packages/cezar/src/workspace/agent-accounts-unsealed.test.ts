import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Home } from '../home/home.ts';
import { testHome, useTestHome } from '../home/test-home.testkit.ts';
import { agentAccountsPath } from '../paths.ts';
import { loadAgentAccounts } from './agent-accounts.ts';

/**
 * The sibling suite seals the runner registry at import, so it cannot show a decode that runs
 * before the process entry seals. This file never seals. A preserved account must still load.
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
  });

  it('keeps an account whose runner is not registered', async () => {
    Home.seedBytes(testHome(), agentAccountsPath(testHome()), Buffer.from(JSON.stringify({
      accounts: [{ id: 'ghost-work', provider: 'ghost', configDir: '~/.ghost-work', label: 'ghost-work' }],
    })));
    const store = await loadAgentAccounts(testHome());
    expect(store.accounts.map((row) => row.provider)).toEqual(['ghost']);
  });
});
