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
const BUILT_IN_DISPLAY = [
  { id: 'claude', displayName: 'Claude Code', modelListName: 'Claude', modelIdScope: 'own' },
  { id: 'codex', displayName: 'Codex', modelListName: 'Codex', modelIdScope: 'own' },
  { id: 'opencode', displayName: 'OpenCode', modelListName: 'OpenCode', modelIdScope: 'provider-spanning' },
  { id: 'pi', displayName: 'pi', modelListName: 'Pi', modelIdScope: 'provider-spanning' },
  { id: 'omp', displayName: 'OMP', modelListName: 'OMP', modelIdScope: 'provider-spanning' },
];

/** What the cockpit's tables held before hearsay-tools/squawk#3898 moved them into the definitions:
 *  the runner picker (`RUNNERS`), `PROVIDER_INSTALL`, `PROVIDERS`' login, `FOLDER_EXAMPLE`, the
 *  icon map, `MODELS_BY_RUNNER`, `RETIRED_MODEL_IDS` and the labels of `AGENT_DESCRIPTORS`. */
const BUILT_IN_COCKPIT_DATA = [
  { id: 'claude', pickerLabel: 'claude', pickerDescription: 'Claude Code CLI', icon: 'bot', installHint: 'npm i -g @anthropic-ai/claude-code', loginCommand: 'claude auth login', accountFolderExample: '~/.claude-second', suggested: ['', 'opus', 'sonnet', 'haiku'], retired: ['claude-fable-5', 'claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5'], paneLabel: 'Claude' },
  { id: 'codex', pickerLabel: 'codex', pickerDescription: 'OpenAI Codex (app-server)', icon: 'sparkles', installHint: 'npm i -g @openai/codex', loginCommand: 'codex login', accountFolderExample: '~/.codex-second', suggested: [''], retired: [], paneLabel: 'Codex' },
  { id: 'opencode', pickerLabel: 'opencode', pickerDescription: 'OpenCode (serve)', icon: 'bot', installHint: 'https://opencode.ai', loginCommand: 'opencode auth login', suggested: [''], retired: [], paneLabel: 'OpenCode' },
  { id: 'pi', pickerLabel: 'pi', pickerDescription: 'pi CLI (provider/model)', icon: 'bot', installHint: 'https://github.com/badlogic/pi-mono', loginCommand: 'pi /login', accountFolderExample: '~/.pi-second/agent', suggested: [''], retired: [], paneLabel: 'Pi' },
  { id: 'omp', pickerLabel: 'OMP', pickerDescription: 'Oh My Pi CLI (provider/model)', icon: 'bot', installHint: 'https://omp.sh', loginCommand: 'omp login', suggested: [''], retired: [], paneLabel: 'OMP' },
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
  const editorPlusCommit = 'An editor-plus-commit: a saved change reaches a run after you commit it to the base branch.';
  expect([...panes].map(([id, pane]) => [id, pane.note])).toEqual([['claude', undefined], ['codex', editorPlusCommit], ['opencode', editorPlusCommit], ['pi', editorPlusCommit], ['omp', editorPlusCommit]]);
  expect([...panes].flatMap(([id, pane]) => pane.groups.filter((group) => group.showsUserMcp).map(() => id))).toEqual(['claude']);
  expect([...panes].flatMap(([id, pane]) => pane.groups.filter((group) => group.empty !== undefined).map((group) => `${id}:${group.id}`))).toEqual(['pi:mcp']);
});
