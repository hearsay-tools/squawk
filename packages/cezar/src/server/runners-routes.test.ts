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
import { BUILT_IN_RUNNER_IDS } from '../runners/ids.ts';
import { runnerGolden } from '../core/runner-golden.testkit.ts';

registerBuiltInRunners();

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** Each runner's entry as `GET /api/v1/runners` sends it, with its Agent config pane's differences, is in its own
 *  folder (`runnerGolden(runner, 'runnerEntry')`): its display facts (hearsay-tools/squawk#3897) and what the cockpit's
 *  tables held before hearsay-tools/squawk#3898 moved them into the definitions: the runner picker (`RUNNERS`),
 *  `PROVIDER_INSTALL`, `PROVIDERS`' login, `FOLDER_EXAMPLE`, the icon map, `MODELS_BY_RUNNER`, `RETIRED_MODEL_IDS`
 *  and the labels of `AGENT_DESCRIPTORS`. */
const entries = BUILT_IN_RUNNER_IDS.map((id) => ({ id, ...runnerGolden(id, 'runnerEntry') }));
const BUILT_IN_DISPLAY = entries.map(({ id, displayName, modelListName, modelIdScope }) => ({ id, displayName, modelListName, modelIdScope }));
const BUILT_IN_COCKPIT_DATA = entries.map(({ id, pickerLabel, pickerDescription, icon, installHint, loginCommand, accountFolderExample, suggested, retired, paneLabel }) => ({
  id, pickerLabel, pickerDescription, icon, installHint, loginCommand, ...(accountFolderExample === undefined ? {} : { accountFolderExample }), suggested, retired, paneLabel,
}));

it('GET /api/v1/runners lists the registered runners in display order with their display part', async () => {
  const detectEnvironment = vi.fn<() => Promise<BackendCheck[]>>(async () => []);
  const root = mkdtempSync(join(tmpdir(), 'cez-runners-route-')); roots.push(root);
  const app = createApp({ home: testHome(), repoRoot: root, store: RunStore.open(join(root, '.ai/cezar')), manager: {} as RunManager, version: 'test', detectEnvironment });
  const probesBefore = detectEnvironment.mock.calls.length;
  const response = await apiRequest(app, '/api/v1/runners');
  expect(response.status).toBe(200);
  const body: unknown = await response.json();
  expect(runnersResponseSchema.parse(body)).toEqual(body);
  const { runners } = runnersResponseSchema.parse(body);
  expect(runners.map(({ id, displayName, modelListName, modelIdScope }) => ({ id, displayName, modelListName, modelIdScope }))).toEqual(BUILT_IN_DISPLAY);
  expect(runners.map((entry) => ({
    id: entry.id, pickerLabel: entry.pickerLabel, pickerDescription: entry.pickerDescription, icon: entry.icon, installHint: entry.installHint,
    loginCommand: entry.loginCommand, ...(entry.accountFolderExample === undefined ? {} : { accountFolderExample: entry.accountFolderExample }),
    suggested: entry.models.suggested.map((preset) => preset.id), retired: entry.models.retired, paneLabel: entry.agentConfig.label,
  }))).toEqual(BUILT_IN_COCKPIT_DATA);
  // It reads the registry and never probes a CLI.
  expect(detectEnvironment.mock.calls.length).toBe(probesBefore);
});

it('sends plain JSON only: no function, RegExp or other part a JSON round trip changes', () => {
  const runners = readRunners();
  expect(JSON.parse(JSON.stringify(runners))).toEqual(runners);
  for (const entry of runners.runners) expect(Object.keys(entry).sort()).toEqual(['accountFolderExample', 'agentConfig', 'displayName', 'icon', 'id', 'installHint', 'loginCommand', 'modelIdScope', 'modelListName', 'models', 'pickerDescription', 'pickerLabel'].filter((key) => key !== 'accountFolderExample' || entry.accountFolderExample !== undefined));
});

it('sends each runner’s Agent config pane: three groups, the MCP note, and who shows the user-level MCP listing or an empty state', () => {
  const panes = new Map(readRunners().runners.map((entry) => [entry.id, entry.agentConfig]));
  for (const pane of panes.values()) {
    expect(pane.groups.map((group) => group.id)).toEqual(['settings', 'mcp', 'memory']);
    expect(pane.groups.find((group) => group.id === 'mcp')?.note).toBeTruthy();
  }
  expect([...panes].map(([id, pane]) => [id, pane.note])).toEqual(entries.map(({ id, paneNote }) => [id, paneNote]));
  expect([...panes].flatMap(([id, pane]) => pane.groups.filter((group) => group.showsUserMcp).map(() => id))).toEqual(entries.filter(({ showsUserMcp }) => showsUserMcp).map(({ id }) => id));
  expect([...panes].flatMap(([id, pane]) => pane.groups.filter((group) => group.empty !== undefined).map((group) => `${id}:${group.id}`))).toEqual(entries.flatMap(({ id, emptyGroups }) => emptyGroups.map((group) => `${id}:${group}`)));
});
