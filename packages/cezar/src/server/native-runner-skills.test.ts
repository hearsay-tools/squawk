import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runnerSkillListSchema } from '@open-mercato/cezar-contract/runner-skills';
import { RUNNER_IDS } from '../core/agent-runner.ts';
import { RunnerSkillCatalog, type SkillCatalogQuery } from '../core/runner-skill-catalog.ts';
import { Home } from '../home/home.ts';
import { testHome, useTestHome } from '../home/test-home.testkit.ts';
import { RunStore } from '../runs/store.ts';
import { mergeWriteAgentAccounts } from '../workspace/agent-accounts.ts';
import type { RunManager } from '../workflows/run.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';

/** Runner list requests share the server's catalog and the session's account resolution. */
describe('runner-native skills API', () => {
  let root: string;
  let homeRoot: string;
  let store: RunStore;
  let app: Hono;
  let calls: SkillCatalogQuery[];
  let catalog: RunnerSkillCatalog;
  let setSkillCatalog: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.stubEnv('CEZ_DRY_RUN', '1');
    root = mkdtempSync(join(tmpdir(), 'cez-native-skills-api-'));
    homeRoot = mkdtempSync(join(tmpdir(), 'cez-native-skills-home-'));
    useTestHome(Home.sandbox(homeRoot));
    mkdirSync(join(root, '.ai/cezar'), { recursive: true });
    store = RunStore.open(join(root, '.ai/cezar'));
    calls = [];
    catalog = new RunnerSkillCatalog({ adapters: Object.fromEntries(RUNNER_IDS.map(runner => [runner, {
      discover: async (query: SkillCatalogQuery) => {
        calls.push(query);
        return { skills: [
          { id: 'project', name: 'Project', scope: 'repo' as const, path: join(query.cwd, '.agents/skills/project/SKILL.md') },
          { id: 'account', name: 'Account', scope: 'user' as const, path: join(homeRoot, 'skills/account/SKILL.md') },
        ], problems: [] };
      },
    }])) });
    setSkillCatalog = vi.fn();
    app = createApp({ home: testHome(), repoRoot: root, store, skillCatalog: catalog,
      manager: { setSkillCatalog } as unknown as RunManager, version: 'test' });
  });

  afterEach(() => {
    store.close();
    useTestHome(undefined);
    vi.unstubAllEnvs();
    for (const directory of [root, homeRoot]) rmSync(directory, { recursive: true, force: true });
  });

  const request = (query: string) => apiRequest(app, `/api/v1/runner-skills?${query}`);
  const list = async (query: string) => {
    const response = await request(query);
    expect(response.status).toBe(200);
    return runnerSkillListSchema.parse(await response.json());
  };

  it.each(RUNNER_IDS)('reads %s with the project folder and portable paths', async runner => {
    const answer = await list(`runner=${runner}`);
    expect(calls).toEqual([{ runner, cwd: root, accountHome: undefined }]);
    expect(answer).toMatchObject({ runner, source: 'live', problems: [], skills: [
      { id: 'project', scope: 'repo', path: '.agents/skills/project/SKILL.md' },
      { id: 'account', scope: 'user', path: join(homeRoot, 'skills/account/SKILL.md') },
    ] });
    expect(setSkillCatalog).toHaveBeenCalledWith(catalog);
  });

  async function addAccount(): Promise<string> {
    const path = join(homeRoot, 'claude-work');
    mkdirSync(path);
    await mergeWriteAgentAccounts(accounts => {
      accounts.accounts.push({ id: 'work', provider: 'claude', configDir: path, label: 'Work', addedAt: '' });
      accounts.selections[root] = { claude: 'work' };
    }, testHome());
    return path;
  }

  it('maps explicit and project-selected accounts to the same accountHome as a session', async () => {
    const path = await addAccount();
    await list('runner=claude');
    await list('runner=claude&account=work');
    expect(calls).toEqual([{ runner: 'claude', cwd: root, accountHome: path }]);
    await list('runner=claude&account=default');
    expect(calls.at(-1)).toEqual({ runner: 'claude', cwd: root, accountHome: undefined });
  });

  it('refuses explicit accounts in hosted mode before probing and keeps project-default listing', async () => {
    await addAccount();
    vi.stubEnv('CEZ_REMOTE', '1');
    for (const account of ['work', 'missing', 'default']) {
      const response = await request(`runner=claude&account=${account}`);
      expect(response.status).toBe(409);
    }
    expect(calls).toEqual([]);
    await list('runner=claude');
    expect(calls).toHaveLength(1);
  });

  it('serves the cached list and refresh=1 probes that runner/account again', async () => {
    await addAccount();
    expect((await list('runner=claude&account=work')).source).toBe('live');
    expect((await list('runner=claude&account=work')).source).toBe('cache');
    expect(calls).toHaveLength(1);
    expect((await list('runner=claude&account=work&refresh=1')).source).toBe('live');
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(calls[0]);
  });

  it.each(['', 'runner=missing', 'runner=claude&refresh=true', 'runner=claude&account='])('refuses invalid query %s before discovery', async query => {
    const response = await request(query);
    expect(response.status).toBe(400);
    expect(await response.json()).toHaveProperty('error');
    expect(calls).toEqual([]);
  });

  it('refuses an unknown explicit account or one owned by another runner before discovery', async () => {
    await addAccount();
    for (const query of ['runner=claude&account=missing', 'runner=codex&account=work']) {
      const response = await request(query);
      expect(response.status).toBe(400);
      expect(await response.json()).toHaveProperty('error');
    }
    expect(calls).toEqual([]);
  });

  it('removes the three legacy skill routes', async () => {
    for (const [path, method] of [['/skills', 'GET'], ['/skills/refresh', 'POST'], ['/skills/importable', 'GET']] as const) {
      expect((await apiRequest(app, `/api/v1${path}`, { method })).status).toBe(404);
    }
    expect(calls).toEqual([]);
  });
});
