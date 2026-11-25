import { BUILT_IN_RUNNER_IDS } from '../core/built-in-runner-ids.testkit.ts';
import { testHome } from '../home/test-home.testkit.ts';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../core/every-runner.testkit.ts';
import { fixture } from './service.testkit.ts';
import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { setRunStatus } from '../runs/run-store.testkit.ts';
import { provisionDelegationSession, DelegationController } from './provision.ts';
import { buildChildEnv } from '../core/agent-env.ts';
import * as transport from './transport.ts';

describe('session provisioning', () => {
  let f: ReturnType<typeof fixture>;
  beforeEach(() => { f = fixture(); });
  afterEach(async () => { await f?.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
  const provision = (id = f.parent.id) => provisionDelegationSession({ projectId: 'project', runId: id, store: f.store, credentials: f.credentials, url: 'http://127.0.0.1:12345/api/v1/delegation' });
  it('delegation emits matching controller authority aliases', () => {
    const session = provisionDelegationSession({projectId: 'project', runId: f.parent.id, store: f.store, credentials: f.credentials, url: 'http://127.0.0.1:12345/api/v1/delegation'})!;
    for (const suffix of ['DELEGATION_URL', 'DELEGATION_TOKEN']) {
      expect(session.env[`CEZ_${suffix}`]).toBeDefined();
      expect(session.env[`HSQ_${suffix}`]).toBe(session.env[`CEZ_${suffix}`]);
    }
    expect(f.credentials.authenticate(session.env.CEZ_DELEGATION_TOKEN!)).toBeDefined();
    session.revoke(); expect(f.credentials.authenticate(session.env.CEZ_DELEGATION_TOKEN!)).toBeUndefined();
  });
  it('rotates session identity, revokes on teardown, and never includes a token in instructions/events', () => {
    const first = provision()!; const old = f.credentials.authenticate(first.env.CEZ_DELEGATION_TOKEN!)!;
    expect(first.instructions).toContain('worker spawn'); expect(first.instructions).toContain('--effort'); expect(first.instructions).toContain('wait --request'); expect(first.instructions).not.toContain(first.env.CEZ_DELEGATION_TOKEN!);
    expect(first.instructions).toContain('Destroy also accepts a running worker: it requests stop, waits up to 30 seconds for termination, stops the worker scope, then removes the worktree and branch.');
    const second = provision()!;
    expect(f.credentials.authenticate(first.env.CEZ_DELEGATION_TOKEN!)).toBeUndefined();
    expect(f.credentials.authenticate(second.env.CEZ_DELEGATION_TOKEN!)).toMatchObject({ runId: f.parent.id });
    // Finishing the previous wrapper must not revoke the newer session.
    first.revoke(); expect(f.credentials.authenticate(second.env.CEZ_DELEGATION_TOKEN!)).toBeDefined();
    f.store.eventLog.appendEvent(f.parent.id, { type: 'text', text: `echo ${second.env.CEZ_DELEGATION_TOKEN}` });
    expect(JSON.stringify(f.store.eventLog.readEvents(f.parent.id))).not.toContain(second.env.CEZ_DELEGATION_TOKEN!);
    vi.stubEnv('CEZ_REDACT_SECRETS', '0');
    f.store.eventLog.appendEvent(f.parent.id, { type: 'text', text: `echo ${second.env.CEZ_DELEGATION_TOKEN}` });
    expect(JSON.stringify(f.store.eventLog.readEvents(f.parent.id))).not.toContain(second.env.CEZ_DELEGATION_TOKEN!);
    second.revoke(); expect(f.credentials.authenticate(second.env.CEZ_DELEGATION_TOKEN!)).toBeUndefined();
    expect(old.runId).toBe(f.parent.id);
  });
  it.each(BUILT_IN_RUNNER_IDS.flatMap(backend => ['0', '1'].map(full => ({ backend, full }))))('passes only session-specific env to $backend with full-env=$full', ({ backend, full }) => {
    const session = provision()!;
    const env = buildChildEnv({ backend, source: { CEZ_HOME: '/live/home', CEZ_ENV_PASSTHROUGH: 'CEZ_HOME', CEZ_AGENT_ENV_FULL: full, CEZ_DELEGATION_TOKEN: 'parent-token', CEZ_DELEGATION_URL: 'http://evil' }, extraEnv: session.env });
    expect(env.CEZ_HOME).toBeUndefined();
    expect(env.CEZ_DELEGATION_TOKEN).toBe(session.env.CEZ_DELEGATION_TOKEN); expect(env.CEZ_DELEGATION_URL).toBe('http://127.0.0.1:12345/api/v1/delegation');
  });
  it('teaches runner selection and live message delivery in the parent instructions', () => {
    const { instructions } = provision()!;
    expect(instructions).toContain(`--runner <${BUILT_IN_RUNNER_IDS.join('|')}>`);
    expect(instructions).toContain('--request-id <UUID> --runner codex');
    expect(instructions).toContain('inbox remains a fallback read during an active turn; it acknowledges only the messages it returns');
    // Messages reach a live session mid-turn; nothing promises turn-boundary delivery.
    expect(instructions).toContain('Messages reach the recipient\'s live session as soon as they are accepted, including mid-turn');
    expect(instructions).toContain('receipts report queued, delivered and consumed separately');
    expect(instructions).toContain('conversation <recipient-run-id> [--before <cursor>] for history or investigation; it does not acknowledge messages');
  });
  // hearsay-tools/cezarion#1149: a parent that never reads --help still learns --attach and its ignored-only rule.
  it('teaches --attach and the parent-file reference in the parent instructions', () => {
    const { instructions } = provision()!;
    expect(instructions).toMatch(/--attach <path> \(repeatable; copies a git-ignored file from your worktree[^)]*commit those instead\)/);
    expect(instructions).toContain('baseline-file, parent-attachment or parent-file references');
  });
  // hearsay-tools/cezarion#2440: listing --effort alone leaves the choice to inherited defaults.
  it('teaches deliberate effort selection, supported levels and inheritance in the parent instructions', () => {
    const { instructions } = provision()!;
    expect(instructions).toMatch(/Before choosing a runner, model or effort, use .* discover runners, then .* discover models --runner=<name>\./);
    expect(instructions).toContain('When overrides are allowed and effortLevels is nonempty, choose an explicit --effort level for the task from that list.');
    expect(instructions).toContain('Do not leave effort on auto by habit.');
    expect(instructions).toContain('An empty effortLevels list advertises no levels; absent metadata means support is unknown.');
    expect(instructions).toContain('Do not guess supported levels or override locked native settings.');
    expect(instructions).toContain('--effort <low|medium|high|xhigh|max|auto>');
    expect(instructions).toContain('Omitting --effort or using --effort auto applies the same rules: same-runner workers inherit the parent\'s effort; workers on another runner leave effort to that runner.');
    expect(instructions).toContain('--runner, --model and --effort fill only the steps that leave those fields unset');
    expect(instructions).toContain('--runner codex --effort high --context');
    expect(instructions).toContain('Use high here only when the selected model advertises it and overrides are allowed.');
  });
  it('teaches per-step settings when workflow models have no shared effort level', () => {
    const { instructions } = provision()!;
    expect(instructions).toContain('A spawn --effort pin applies to every agent step whose effort is unset.');
    expect(instructions).toContain('Use a shared effort only when every affected step\'s model advertises that level; otherwise use a workflow with compatible per-step effort settings.');
    expect(instructions).toContain('A high-only model and a low-only model need separate step settings.');
    expect(instructions).toContain('Omission and auto do not clear an inherited effort pin.');
  });
  it('teaches that several waits can be open, messages close none, and cancel-wait stops one', () => {
    const { instructions } = provision()!;
    expect(instructions).toContain('Several waits can be open at once (workers, peers, CI, timers)');
    expect(instructions).toContain('Messages wake you and close no wait');
    expect(instructions).toContain('cancel-wait <wait-id> stops one wait');
  });
  // hearsay-tools/cezarion#1995: the peer wait and the request kind are taught where the request wait is.
  it('teaches the peer wait and cezar_wait kinds request and peer', () => {
    const { instructions } = provision()!;
    expect(instructions).toMatch(/wait --peer <task-id> \[--peer <another-task-id>\] --timeout-seconds <1-7200> \(or cezar_wait with kind "peer"\)/);
    expect(instructions).toContain('(or cezar_wait with kind "request") to register a request wait');
    expect(instructions).toContain("except a named peer's message to a peer wait");
  });
  it("tells a shared worker that it shares its parent's worktree, and the parent about --workspace shared (hearsay-tools/squawk#3819)", async () => {
    const notice = "You share your parent's worktree: do not write there unless your task says so.";
    const shared = await f.service.spawn(f.caller, { task: 'review', workspace: 'shared', requestId: randomUUID() });
    const isolated = await f.service.spawn(f.caller, { task: 'build', baseline: 'HEAD', requestId: randomUUID() });
    expect(provision(shared.workerId)!.instructions).toContain(`Your parent run ID is ${f.parent.id}. ${notice}`);
    expect(provision(isolated.workerId)!.instructions).not.toContain(notice);
    const root = provision()!.instructions;
    expect(root).toContain('--workspace shared (the worker runs in your worktree at your HEAD, with no worktree or branch of its own and no --baseline; see spawn --help)');
    expect(root).not.toContain(notice);
  });
  it('never promotes invalid/worker records to roots', async () => {
    const ordinary = f.store.createRun({ title: 'ordinary', task: 'ordinary', workflow: 'quick-task', steps: [] });
    f.store.updateRun(ordinary.id, { delegation: { role: 'invalid' } });
    expect(provision(ordinary.id)).toBeUndefined();
    const { workerId } = await f.service.spawn(f.caller, { task: 'worker', baseline: 'HEAD', requestId: randomUUID() });
    const worker = provision(workerId)!;
    // hearsay-tools/squawk#3819: a root's worker may start one shared worker; a worker with no spawn grant keeps the old sentence.
    expect(worker.instructions).toMatch(new RegExp(String.raw`You may start one shared-workspace Squawk worker at a time; destroy it before you start the next\. Run .* worker spawn --help first\. You cannot control peers`));
    expect(worker.instructions).not.toContain('You cannot spawn');
    expect(worker.instructions).toContain('wait --request'); expect(worker.instructions).toContain(f.parent.id); expect(worker.instructions).toContain('message reply');
    // #505: a worker's questions go to its parent, which replies or asks the human.
    expect(worker.instructions).toContain('Ask your parent with hsq message request; any question you raise goes to your parent too, never to a human.');
    expect(worker.instructions).not.toContain('cezar_ask');
    // hearsay-tools/cezarion#1327: a park notice quotes the worker's last message to its waiting parent.
    expect(worker.instructions).toContain(`Squawk tells your parent what you wait on and quotes your last message`);
    expect(worker.instructions).not.toContain(`Squawk sends you a notice`);
    const root = provision()!;
    expect(root.instructions).toContain(`Squawk sends you a notice from it naming what it waits on, at most one per wait; like any message it wakes you and closes no wait`);
    expect(root.instructions).not.toContain('Cezar tells your parent');
    expect(root.instructions).toContain('Worker questions arrive as requests carrying a question');
    expect(root.instructions).toContain('--request-id <question-id>');
    // hearsay-tools/cezarion#1234: an open question takes the parent's own words.
    expect(root.instructions).toContain("one '<header>: <answer>' line per question (an option's label, or your own words for a question without options)");
    const granted = f.store.getRun(workerId)!.delegation!;
    expect(granted).toMatchObject({ role: 'worker', spawnGrant: { kinds: ['shared'], live: 1 } });
    expect(root.instructions).toContain('A worker may start one shared-workspace worker of its own at a time.');
    expect(root.instructions).toContain('Workers cannot message peers.');
    setRunStatus(f.store, workerId, RUN_STATUS.running);
    await expect(f.service.spawn(f.credentials.authenticate(worker.env.CEZ_DELEGATION_TOKEN!)!, { task: 'no', workspace: 'isolated', baseline: 'HEAD', requestId: randomUUID() }))
      .rejects.toMatchObject({ code: 'denied_scope', message: expect.stringContaining('Allowed: --workspace shared') });
    // A worker another worker started: its parent is that worker, and its questions go by request message only.
    const direct = f.store.getRun(workerId)!.delegation!;
    const supervisorRunId = randomUUID();
    f.store.commitDelegation([{ id: workerId, delegation: { ...direct, supervisorRunId } as typeof direct }]);
    const supervised = provision(workerId)!.instructions;
    expect(supervised).toContain(`Your parent run ID is ${supervisorRunId}.`);
    expect(supervised).toContain('Send every question to your parent as a request with hsq message request and wait for its reply: no question card reaches your parent or a human.');
    expect(supervised).not.toContain('any question you raise goes to your parent too');
    f.store.commitDelegation([{ id: workerId, delegation: direct }]);
    expect(root.instructions).toContain('Message, steer and diff apply to workers you started yourself; a worker that one of your workers started is reached through that worker.');
    const { spawnGrant: _grant, ...ungranted } = granted as typeof granted & { spawnGrant?: unknown };
    f.store.commitDelegation([{ id: workerId, delegation: ungranted as typeof granted }]);
    expect(provision(workerId)!.instructions).toContain(`You cannot spawn Squawk workers. You cannot control peers`);
  });
  // hearsay-tools/cezarion#2279: both roles may use native subagents; each mechanism has its own
  // purpose, and `cez message` is the only channel to another Squawk task.
  it('gives native subagents and Cezar workers distinct purposes, for roots and workers', async () => {
    const { workerId } = await f.service.spawn(f.caller, { task: 'worker', baseline: 'HEAD', requestId: randomUUID() });
    const worker = provision(workerId)!.instructions;
    const root = provision()!.instructions;
    expect(root).toContain('Use native subagents for work that needs no separate worktree: research, code reading and focused analysis.');
    expect(root).toContain('For example, a subagent reads the parser and summarizes how it handles errors.');
    expect(root).toContain(`Use Squawk workers for work that needs its own worktree, its own commits or a lifecycle Squawk tracks.`);
    expect(root).toContain(`Also use a Squawk worker when the task needs a model available only through another runner, even if the work is research or analysis.`);
    expect(root).toContain(`Native subagents need no Squawk worker, worktree, collection or destruction.`);
    expect(worker).toContain('You may use native subagents for research, code reading and focused analysis.');
    expect(worker).not.toContain(`Also use a Squawk worker`);
    for (const text of [root, worker]) {
      expect(text).toContain('You may message your own native subagents with your runner\'s tools.');
      expect(text).toMatch(new RegExp(String.raw`Reach another Squawk task only through .* message; never use your runner's native tools for that\.`));
    }
  });
  it('always starts the listener; one failed listener leaves ordinary execution unprovisioned and logs once without secrets', async () => {
    const listen = vi.spyOn(transport, 'startDelegationTransport'); const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('CEZ_DELEGATION', '0'); const on = await DelegationController.start(); expect(listen).toHaveBeenCalledTimes(1); expect(on.url).toBeDefined(); await on.close();
    listen.mockRejectedValue(Error('unavailable'));
    const broken = await DelegationController.start();
    broken.attachProject({ home: testHome(), id: 'project', root: f.root, store: f.store, manager: f.manager });
    expect(broken.url).toBeUndefined(); expect(warn).toHaveBeenCalledTimes(1); await broken.close();
  });
  // hearsay-tools/cezarion#2784: the per-task switches decide what a root session is taught and issued.
  describe('task access', () => {
    const root = (access: { allowWorkers?: boolean; allowMessaging?: boolean }) =>
      f.store.createRun({ title: 'root', task: 'root', workflow: 'quick-task', steps: [], ...access });
    it('a record with no saved choice gets workers and messaging', () => {
      const legacy = root({});
      const session = provision(legacy.id)!;
      expect(session.env.CEZ_DELEGATION_TOKEN).toBeTypeOf('string');
      expect(session.instructions).toContain(' spawn --baseline parent-head');
      expect(session.instructions).not.toContain('off for this task');
      expect(f.store.getRun(legacy.id)?.delegation).toMatchObject({ role: 'root' });
    });
    it('workers off keeps messaging and teaches no spawn', () => {
      const session = provision(root({ allowWorkers: false, allowMessaging: true }).id)!;
      expect(session.env.CEZ_DELEGATION_TOKEN).toBeTypeOf('string');
      expect(session.instructions).toContain(`Squawk workers are off for this task. A human can turn them on in the task menu.`);
      expect(session.instructions).not.toContain(' spawn --baseline parent-head');
      expect(session.instructions).not.toContain('You still manage the workers you own');
      expect(session.instructions).toContain('wait --peer <task-id>');
      expect(session.instructions).not.toContain('Task messaging is off');
    });
    it('messaging off keeps workers and says peers are unreachable', () => {
      const session = provision(root({ allowWorkers: true, allowMessaging: false }).id)!;
      expect(session.instructions).toContain(' spawn --baseline parent-head');
      expect(session.instructions).toContain('Task messaging is off for this task: you cannot list, message or wait on peer tasks');
    });
    it('both off issues no credential and keeps the governed-session cross-session controls', () => {
      const run = root({ allowWorkers: false, allowMessaging: false });
      const session = provision(run.id)!;
      // The endpoint without a token: discovery refuses rather than reach the cockpit.
      expect(session).toMatchObject({ restrictCrossSessionMessaging: true, env: { CEZ_DELEGATION_URL: 'http://127.0.0.1:12345/api/v1/delegation' } });
      expect(session.env).not.toHaveProperty('CEZ_DELEGATION_TOKEN');
      expect(session.instructions).toContain(`Squawk workers and task messaging are off for this task`);
      expect(session.instructions).toContain('they reach you at your next session');
      expect(session.instructions).not.toMatch(/index\.[jt]s' message/);
      expect(f.store.getRun(run.id)?.delegation).toBeUndefined();
    });
    it('both off still issues a credential while a peer request it accepted is open', async () => {
      const lone = root({});
      await f.service.send(f.caller, { id: randomUUID(), recipientRunId: lone.id, kind: 'request', text: 'Check this', timeoutSeconds: 600 });
      f.store.updateRun(lone.id, { allowWorkers: false, allowMessaging: false });
      const session = provision(lone.id)!;
      expect(session.env.CEZ_DELEGATION_TOKEN).toBeTypeOf('string');
      expect(session.instructions).toContain('message reply');
      expect(session.instructions).toContain('Task messaging is off for this task');
    });
    it('both off still issues a credential to manage workers the task already owns', async () => {
      await f.service.spawn(f.caller, { task: 'worker', baseline: 'HEAD', requestId: randomUUID() });
      f.store.updateRun(f.parent.id, { allowWorkers: false, allowMessaging: false });
      const session = provision()!;
      expect(session.env.CEZ_DELEGATION_TOKEN).toBeTypeOf('string');
      expect(session.instructions).toContain('You still manage the workers you own');
      expect(session.instructions).toContain('Message, steer and diff apply to workers you started yourself; a worker that one of your workers started is reached through that worker.');
      expect(session.instructions).toContain(`Squawk workers are off for this task.`);
    });
  });
});
