import { sealTestRunners } from '../core/runner-registry.testkit.ts';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { setRunStatus } from '../runs/run-store.testkit.ts';
import { setHostScope } from '../worker-scope/worker-scopes.ts';
import { fixture } from './service-engine.testkit.ts';
import { ensureOwnedWorkspace } from './workspace.ts';
import { processStartToken } from '../core/process-stat.ts';
import { workerExecutionsOf } from './worker-executions.ts';

sealTestRunners();

describe('resume with worker services (hearsay-tools/squawk#3901)', () => {
  let f: ReturnType<typeof fixture>;
  let sleeper: ChildProcess | undefined;
  afterEach(async () => {
    if (sleeper && sleeper.exitCode === null && sleeper.signalCode === null) {
      const exited = new Promise(resolve => sleeper!.once('exit', resolve));
      sleeper.kill('SIGKILL'); await exited;
    }
    await f?.close(); setHostScope(undefined); vi.restoreAllMocks();
  });

  it.skipIf(process.platform === 'win32')('accepts Continue while a detached long-lived process still runs in the worker scope', async () => {
    setHostScope({ backend: 'groups', reason: 'test' });
    f = fixture();
    const { workerId } = await f.service.spawn(f.caller, { task: 'work', baseline: 'HEAD', requestId: randomUUID() });
    f.manager.requestWorkerStop(workerId);
    // bound: drain the accepted scheduler entry before seeding a completed prior session.
    expect(await f.manager.awaitRunTermination(workerId, 8_000)).toBe(true);
    const run = f.store.getRun(workerId)!;
    const generation = f.store.workerExecutions.commitWorkerExecutionStart(workerId);
    const workspace = await ensureOwnedWorkspace(f.root, run);
    const scope = workerExecutionsOf(f.store).scopes.spawnScope(workerId);
    const [command, args] = scope.command(process.execPath, ['-e', "console.log('ready'); setInterval(() => {}, 1000)"]);
    sleeper = spawn(command, args, { cwd: workspace.path, detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    await new Promise(resolve => sleeper!.stdout!.once('data', resolve));
    scope.started(sleeper.pid!);
    setRunStatus(f.store, workerId, RUN_STATUS.review);
    f.store.workerExecutions.commitWorkerExecutionComplete(workerId, generation);
    expect(f.store.workerExecutions.scopes.empty(workerId)).toBe(false);
    await expect(f.service.send(f.caller, { id: randomUUID(), recipientRunId: workerId,
      kind: 'request', text: 'Continue the work', resume: true, timeoutSeconds: 600 })).resolves.toMatchObject({ effect: 'applied' });
    expect(f.store.workerExecutions.readWorkerExecution(workerId)?.generation).not.toBe(generation);
    expect(sleeper.exitCode).toBeNull();
    expect(sleeper.signalCode).toBeNull();
    expect(f.store.workerExecutions.scopes.empty(workerId)).toBe(false);
  });

  it.skipIf(process.platform === 'win32').each(['controller', 'session'] as const)('names the live %s rule and executable in a resume refusal', async kind => {
    f = fixture();
    const { workerId } = await f.service.spawn(f.caller, { task: 'work', baseline: 'HEAD', requestId: randomUUID() });
    f.manager.requestWorkerStop(workerId);
    // bound: drain the accepted scheduler entry before seeding a completed prior session.
    expect(await f.manager.awaitRunTermination(workerId, 8_000)).toBe(true);
    const generation = f.store.workerExecutions.commitWorkerExecutionStart(workerId);
    await ensureOwnedWorkspace(f.root, f.store.getRun(workerId)!);
    sleeper = spawn(process.execPath, ['-e', "console.log('ready'); setInterval(() => {}, 1000)"], { stdio: ['ignore', 'pipe', 'ignore'] });
    await new Promise(resolve => sleeper!.stdout!.once('data', resolve));
    const processEntry = { pid: sleeper.pid!, startToken: processStartToken(sleeper.pid!) };
    writeFileSync(join(f.root, '.ai/cezar/runs', `${workerId}.processes.json`), JSON.stringify({ generation,
      controller: kind === 'controller' ? processEntry : { pid: process.pid, startToken: processStartToken(process.pid) },
      processes: kind === 'session' ? [processEntry] : [] }));
    setRunStatus(f.store, workerId, RUN_STATUS.review);
    f.store.workerExecutions.commitWorkerExecutionComplete(workerId, generation);
    const refusal = f.manager.continueRun(workerId, { text: 'Continue the work', freshSession: true });
    expect(refusal).toMatchObject({ ok: false, error: expect.stringContaining(`${sleeper.pid} (node`), next: expect.stringContaining('retry the same command') });
    expect(refusal).toMatchObject({ error: expect.stringContaining(kind === 'controller' ? 'another live controller' : 'live processes of the previous session') });
  });
});
