import { testHome } from '../home/test-home.testkit.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { runnersResponseSchema } from '@open-mercato/cezar-contract/runners';
import type { BackendCheck } from '../core/backend-detect.ts';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { readRunners } from './runners-routes.ts';
import { createApp } from './server.ts';
import { registerBuiltInRunners } from '../runners/built-in.ts';

registerBuiltInRunners();

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** Today's display facts of the built-in runners, in display order (hearsay-tools/squawk#3897). */
const BUILT_IN_ENTRIES = [
  { id: 'claude', displayName: 'Claude Code', modelListName: 'Claude', modelIdScope: 'own' },
  { id: 'codex', displayName: 'Codex', modelListName: 'Codex', modelIdScope: 'own' },
  { id: 'opencode', displayName: 'OpenCode', modelListName: 'OpenCode', modelIdScope: 'provider-spanning' },
  { id: 'pi', displayName: 'pi', modelListName: 'Pi', modelIdScope: 'provider-spanning' },
  { id: 'omp', displayName: 'OMP', modelListName: 'OMP', modelIdScope: 'provider-spanning' },
];

it('GET /api/v1/runners lists the registered runners in display order with their display part', async () => {
  const detectEnvironment = vi.fn<() => Promise<BackendCheck[]>>(async () => []);
  const root = mkdtempSync(join(tmpdir(), 'cez-runners-route-')); roots.push(root);
  const app = createApp({ home: testHome(), repoRoot: root, store: RunStore.open(join(root, '.ai/cezar')), manager: {} as RunManager, version: 'test', detectEnvironment });
  const probesBefore = detectEnvironment.mock.calls.length;
  const response = await apiRequest(app, '/api/v1/runners');
  expect(response.status).toBe(200);
  const body: unknown = await response.json();
  expect(runnersResponseSchema.parse(body)).toEqual(body);
  expect(body).toEqual({ runners: BUILT_IN_ENTRIES });
  // It reads the registry and never probes a CLI.
  expect(detectEnvironment.mock.calls.length).toBe(probesBefore);
});

it('sends plain JSON only: no function, RegExp or other part a JSON round trip changes', () => {
  const runners = readRunners();
  expect(JSON.parse(JSON.stringify(runners))).toEqual(runners);
  for (const entry of runners.runners) expect(Object.keys(entry).sort()).toEqual(['displayName', 'id', 'modelIdScope', 'modelListName']);
});
