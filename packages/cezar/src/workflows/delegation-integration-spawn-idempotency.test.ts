import { sealTestRunners } from '../core/runner-registry.testkit.ts';
import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import type { WorkerSpawnResult } from '@open-mercato/cezar-contract';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { testHome } from '../home/test-home.testkit.ts';
import { runWorkerCommand } from '../delegation/cli.ts';
import { CredentialRegistry } from '../delegation/credentials.ts';
import { createDelegationRoutes } from '../delegation/routes.ts';
import { DelegationService, type DelegationManager } from '../delegation/service.ts';
import { createDelegationApp, startDelegationTransport } from '../delegation/transport.ts';
import { openTestRunStore } from '../runs/run-store-open.testkit.ts';
import { setRunStatus } from '../runs/run-store.testkit.ts';
import type { RunStore } from '../runs/store.ts';
import type { DelegationExecutionSettings } from './run/types.ts';
import { unused } from './unused.testkit.ts';
import { claudeRunner } from '../runners/claude/definition.ts';
import { codexRunner } from '../runners/codex/definition.ts';
import '../core/created-runners.testkit.ts';

sealTestRunners(claudeRunner, codexRunner);

// The worker CLI maps `--runner` and `--backend` to the request's `backend` (delegation/cli.ts), and
// DelegationService.spawn dedupes a retry by request id and payload hash (delegation/service.ts).
// The manager is a fake: a spawn only selects the worker's settings and enqueues the accepted run.

let root: string, store: RunStore, credentials: CredentialRegistry, unregister: () => void;
let transport: Awaited<ReturnType<typeof startDelegationTransport>>, env: NodeJS.ProcessEnv;
let selections: Array<{ backend?: string | undefined }>, enqueued: string[];

function fakeManager(): DelegationManager {
  return unused<DelegationManager>('delegation manager', {
    setWorkerWorkspaces: () => {},
    pauseWorkerCleanup: () => {},
    selectDelegationExecutionSettings: async (_parentId, selection): Promise<DelegationExecutionSettings> => {
      selections.push(selection);
      const runner = selection.backend ?? 'claude';
      return { cwd: root, runner, agentProfile: 'default', accountBinding: { provider: runner, profileId: 'default', homePath: root } };
    },
    enqueueOwnedRun: id => { enqueued.push(id); },
  });
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'cez-delegation-spawn-idempotency-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' });
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'test'); git('config', 'user.email', 'test@local');
  writeFileSync(join(root, 'shared.txt'), 'baseline\n'); git('add', '.'); git('commit', '-qm', 'base');
  store = openTestRunStore(join(root, '.ai/cezar'), { keepLive: true });
  const parent = store.createRun({ title: 'parent', task: 'Coordinate independent implementations', workflow: 'quick-task', runner: 'claude', steps: [] });
  setRunStatus(store, parent.id, RUN_STATUS.running, { worktreePath: root, delegation: { role: 'root', permissions: ['spawn', 'inspect', 'steer', 'stop', 'destroy', 'diff', 'wait'], receipts: [] } });
  selections = []; enqueued = [];
  const service = new DelegationService();
  unregister = service.registerProject({ home: testHome(), id: 'integration', root, store, manager: fakeManager() });
  credentials = new CredentialRegistry();
  transport = await startDelegationTransport(createDelegationApp(createDelegationRoutes(service, credentials)));
  env = { HSQ_DELEGATION_URL: transport.url, HSQ_DELEGATION_TOKEN: credentials.issue('integration', parent.id, randomUUID()) };
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(async () => {
  await transport.close(); unregister(); credentials.close(); store.close();
  vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true });
});

async function command(args: string[]): Promise<WorkerSpawnResult> {
  const output = vi.mocked(console.log);
  const calls = output.mock.calls.length;
  expect(await runWorkerCommand(args, env)).toBe(0);
  expect(output.mock.calls).toHaveLength(calls + 1);
  return JSON.parse(String(output.mock.calls.at(-1)?.[0])) as WorkerSpawnResult;
}

// hearsay-tools/cezarion#632: `--runner` and `--backend` fill the same request field, so a retry
// that switches spelling hashes identically and dedupes instead of reporting a payload conflict.
it('dedupes a --runner retry of a --backend spawn under the same request id', async () => {
  const requestId = randomUUID();
  const args = (flag: string) => ['spawn', '--baseline', 'parent-head', '--request-id', requestId, flag, 'codex', '--context', 'Parser only', 'Review parser'];
  const first = await command(args('--backend'));
  expect(selections).toEqual([{ backend: 'codex' }]);
  expect(store.getRun(first.workerId)?.runner).toBe('codex');
  const retry = await command(args('--runner'));
  expect(retry.workerId).toBe(first.workerId);
  expect(store.queries.listRuns().filter(run => run.delegation?.role === 'worker')).toHaveLength(1);
  expect(enqueued).toEqual([first.workerId]);
});
