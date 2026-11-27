import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sealTestRunners } from '../core/runner-registry.testkit.ts';
import { fixtureRunner } from '../runners/fixture/definition.testkit.ts';
import { fixture } from './service.testkit.ts';
import { provisionDelegationSession } from './provision.ts';

const noSubagentsRunner = {
  ...fixtureRunner,
  id: 'no-subagents-fixture',
  accounts: { ...fixtureRunner.accounts, homeSlot: 'noSubagentsFixture' },
  facts: { ...fixtureRunner.facts, nativeSubagents: 'none' as const, childWork: 'none' as const },
};

sealTestRunners(fixtureRunner, noSubagentsRunner);

describe('provisionDelegationSession nativeSubagents guidance', () => {
  let f: ReturnType<typeof fixture>;
  beforeEach(() => { f = fixture(); });
  afterEach(async () => { await f?.close(); });

  const provision = (runId: string, runner: string) => provisionDelegationSession({
    projectId: 'project', runId, store: f.store, credentials: f.credentials,
    url: 'http://127.0.0.1:12345/api/v1/delegation', runner,
  })!;

  it('omits native subagent recommendations when the active runner declares nativeSubagents: none', async () => {
    const { workerId } = await f.service.spawn(f.caller, { task: 'worker', baseline: 'HEAD', requestId: randomUUID() });

    const rootWorkersOn = provision(f.parent.id, noSubagentsRunner.id).instructions;
    expect(rootWorkersOn).not.toContain('Use native subagents');
    expect(rootWorkersOn).not.toContain('Native subagents need no');
    expect(rootWorkersOn).not.toContain('You may message your own native subagents');
    expect(rootWorkersOn).toContain('Use Squawk workers for work that needs its own worktree');
    expect(rootWorkersOn).toContain('Reach another Squawk task only through');

    const offRun = f.store.createRun({ title: 'off', task: 'off', workflow: 'quick-task', steps: [], allowWorkers: false, allowMessaging: true });
    const rootWorkersOff = provision(offRun.id, noSubagentsRunner.id).instructions;
    expect(rootWorkersOff).not.toContain('Use native subagents');
    expect(rootWorkersOff).not.toContain('You may message your own native subagents');
    expect(rootWorkersOff).toContain('Reach another Squawk task only through');

    const bothOffRun = f.store.createRun({ title: 'both-off', task: 'both-off', workflow: 'quick-task', steps: [], allowWorkers: false, allowMessaging: false });
    const bothOff = provision(bothOffRun.id, noSubagentsRunner.id).instructions;
    expect(bothOff).not.toContain('You may use native subagents');
    expect(bothOff).toContain('No agent channel to another task exists: tell the user instead.');

    const worker = provision(workerId, noSubagentsRunner.id).instructions;
    expect(worker).not.toContain('You may use native subagents');
    expect(worker).not.toContain('You may message your own native subagents');
    expect(worker).toContain('Reach another Squawk task only through');
  });

  it('keeps native subagent recommendations when the active runner enables them', () => {
    const enabled = provision(f.parent.id, fixtureRunner.id).instructions;
    expect(enabled).toContain('Use native subagents for work that needs no separate worktree');
    expect(enabled).toContain("You may message your own native subagents with your runner's tools.");
  });
});
