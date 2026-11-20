import '../core/created-runners.testkit.ts';
import { setRunStatus } from '../runs/run-store.testkit.ts';
import { RUN_STATUS, STEP_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runWorkerCommand, runMessageCommand } from './cli.ts';
import { fixture } from './service-engine.testkit.ts';
import { seedWorkerWait } from './service.testkit.ts';
import { createDelegationRoutes } from './routes.ts';
import { createDelegationApp, startDelegationTransport } from './transport.ts';
import { workerCleanups } from './worker-cleanup.ts';
import { registerRunner } from '../core/runner-registry.ts';
import { claudeRunner } from '../runners/claude/definition.ts';
registerRunner(claudeRunner);

// The resume answer needs Continue admission and cancel-wait needs an open wait: both need the run engine.
// Every test spawns real worker worktrees through git. Alone at load 91 they take 0.25-1.2 s
// (the transport round trips, with `wait`'s ~1 s, are the slowest); the Node 24.15 floor shard
// runs them about 4x slower, where two of them passed 5 s (hearsay-tools/cezarion#974).
describe('bundled worker CLI', { timeout: 20_000 }, () => {
  let f: ReturnType<typeof fixture>, transport: Awaited<ReturnType<typeof startDelegationTransport>>;
  let output: ReturnType<typeof vi.spyOn>, env: NodeJS.ProcessEnv;
  beforeEach(async () => {
    f = fixture(workerCleanups());
    transport = await startDelegationTransport(createDelegationApp(createDelegationRoutes(f.service, f.credentials)));
    env = { CEZ_DELEGATION_URL: transport.url, CEZ_DELEGATION_TOKEN: f.token };
    output = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(async () => { await transport?.close(); await f?.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
  const json = () => JSON.parse(String(output.mock.calls.at(-1)?.[0]));
  it('sends a two-hour ordinary request and keeps longer resume deadlines restricted', async () => {
    const { workerId } = await f.service.spawn(f.caller, { task: 'work', baseline: 'parent-head', requestId: randomUUID() });
    const args = ['request', workerId, 'Fix review', '--id', randomUUID(), '--timeout-seconds', '7200'];
    expect(await runMessageCommand(args, env)).toBe(0);
    expect(Date.parse(json().message.deadline) - Date.parse(json().message.createdAt)).toBe(7_200_000);
    args[args.length - 1] = '7201';
    args[4] = randomUUID();
    expect(await runMessageCommand(args, env)).toBe(1);
    expect(json().code).toBe('invalid_input');
    expect(await runWorkerCommand(['resume', ...args.slice(1)], env)).toBe(1);
    expect(json().code).toBe('incompatible_state');
    f.manager.cancel(workerId);
    await f.manager.awaitRunTermination(workerId, 10_000);
    f.store.updateStep(workerId, 'task', { status: STEP_STATUS.done, sessionId: 'previous-session', backend: 'claude' });
    const generation = f.store.commitWorkerExecutionStart(workerId);
    setRunStatus(f.store, workerId, RUN_STATUS.done);
    f.store.commitWorkerExecutionComplete(workerId, generation);
    expect(await runWorkerCommand(['resume', ...args.slice(1)], env)).toBe(0);
    const sent = json();
    expect(Date.parse(sent.message.deadline) - Date.parse(sent.message.createdAt)).toBe(7_201_000);
  });
  it('sends explicit wait modes and cancels a wait by ID using the provisioned transport', async () => {
    expect(await runWorkerCommand(['spawn', '--baseline', 'parent-head', '--request-id', randomUUID(), 'work'], env)).toBe(0);
    const { workerId } = json();
    for (const mode of ['one', 'any', 'all']) {
      expect(await runWorkerCommand(['wait', workerId, '--mode', mode], env)).toBe(1);
      expect(json().code).toBe('incompatible_state');
    }
    const delegation = f.store.getRun(f.parent.id)!.delegation!;
    if (delegation.role !== 'root') throw Error('fixture');
    f.store.commitDelegation([{ id: f.parent.id, delegation: { ...delegation, permissions: ['wait'] } }]);
    const waitId = seedWorkerWait(f.store, f.parent.id, [workerId]);
    expect(await runWorkerCommand(['cancel-wait', waitId], env)).toBe(0);
    expect(json()).toMatchObject({ wait: { id: waitId, reason: 'cancelled' } });
    expect(f.store.getRun(workerId)?.status).toBe('queued');
    for (const argv of [['wait', workerId, randomUUID(), '--mode', 'one'], ['wait', workerId, '--mode', 'invalid'], ['cancel-wait'], ['cancel-wait', 'bad'], ['cancel-wait', waitId, 'extra']]) {
      expect(await runWorkerCommand(argv, env)).toBe(1); expect(json().code).toBe('invalid_input');
    }
  });

});
