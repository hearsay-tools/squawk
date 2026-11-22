import { testHome } from '../home/test-home.testkit.ts';
import { resolveForgeRoot } from './forge/index.ts';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import type { ForgeSearchData } from './forge/types.ts';
import { createApp } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';

/**
 * `GET /api/v1/github/search?kind=…&q=…` (#730).
 *
 * Why this route exists: `GET /api/v1/github` lists the OPEN set only, and the tab's search is an
 * in-memory filter over that payload — so a closed or merged issue/PR is not merely "outside the
 * fetched window", it was never fetched and nothing the user types can reach it. This is the
 * endpoint that asks the forge instead.
 *
 * The contract under test is the route boundary: zod-validated params (400 on anything malformed,
 * never a throw) and a `ForgeSearchData` payload. Driven through `CEZ_DRY_RUN=1` so no `gh` is
 * touched — the gh-shelling, cross-state and degrade paths are covered in the driver's own suite.
 */
describe('the github search API', () => {
  let repoRoot: string;
  let store: RunStore;
  let app: Hono;
  const prevDryRun = process.env.CEZ_DRY_RUN;

  beforeAll(() => {
    process.env.CEZ_DRY_RUN = '1';
  });
  afterAll(() => {
    if (prevDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = prevDryRun;
  });

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-ghsearch-'));
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    app = createApp({ home: testHome(), repoRoot, store, manager: {} as RunManager, version: '0.0.0-test' });
  });

  afterEach(() => {
    store.persistence.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('finds a PR by number', async () => {
    const res = await apiRequest(app, '/api/v1/github/search?kind=pr&q=128');
    expect(res.status).toBe(200);
    const body = (await res.json()) as ForgeSearchData;
    expect(body.available).toBe(true);
    expect(body.items.map((i) => i.number)).toEqual([128]);
  });

  it('finds an issue by text', async () => {
    const res = await apiRequest(app, '/api/v1/github/search?kind=issue&q=Login');
    expect(res.status).toBe(200);
    const body = (await res.json()) as ForgeSearchData;
    expect(body.items.map((i) => i.number)).toEqual([142]);
  });

  it('rejects malformed kind, query and limit values', async () => {
    for (const query of [
      'q=128', 'kind=commit&q=128', 'kind=pr', 'kind=pr&q=', 'kind=pr&q=%20%20',
      `kind=pr&q=${'a'.repeat(257)}`,
      'kind=pr&q=128&limit=0', 'kind=pr&q=128&limit=abc', 'kind=pr&q=128&limit=9999',
    ]) {
      const res = await apiRequest(app, `/api/v1/github/search?${query}`);
      expect(res.status, query).toBe(400);
    }
  });

  it('answers identically on the project-scoped mirror', async () => {
    const plain = await apiRequest(app, '/api/v1/github/search?kind=pr&q=128');
    const scoped = await apiRequest(app, '/api/v1/p/default/github/search?kind=pr&q=128');
    expect(scoped.status).toBe(plain.status);
    // Compared by identity, not deep-equality: the dry-run catalog stamps `createdAt` off the
    // clock at call time, so two calls a millisecond apart legitimately differ there.
    const numbers = async (res: Response) =>
      ((await res.json()) as ForgeSearchData).items.map((i) => i.number);
    expect(await numbers(scoped)).toEqual(await numbers(plain));
  });
  it('degrades when the driver omits searchItems', async () => {
    const withoutCapability = createApp({ home: testHome(),
      repoRoot, store, manager: {} as RunManager, version: 'test',
      forgeFactory: (root) => {
        const driver = resolveForgeRoot(root);
        delete driver.searchItems;
        return driver;
      },
    });
    for (const mount of ['/api/v1', '/api/v1/p/default']) {
      const response = await apiRequest(withoutCapability, `${mount}/github/search?kind=pr&q=128`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ available: false, reason: 'GitHub is unavailable', items: [] });
    }
  });

});
