import { testHome } from '../home/test-home.testkit.ts';
import { setRunStatus } from '../runs/run-store.testkit.ts';
import { openTestRunStore } from '../runs/run-store-open.testkit.ts';
import { createFixtureManager } from '../workflows/fixture-cleanup.testkit.ts';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { RUN_STATUS, STEP_KIND, STEP_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { provisionWorkflowFixture, until, PROVISION_ROWS } from './provision-workflows.testkit.ts';

// Git worktrees + a live RunManager contend under full-suite workers. until() is already 15s;
// the default 5s testTimeout / 10s hookTimeout cannot finish those waits. Teardown still cancels
// and finishes sessions without polling, then waits for owned work before removing the fixture.
describe('per-step worker identity across mixed-runner chains', { timeout: 15_000 }, () => {
  const context = provisionWorkflowFixture();
  let f: typeof context.f, controller: typeof context.controller;
  const { sessions, recoveredManagers, recoveredStores, acceptIdentityWorker, launchAccepted, doneTurn } = context;
  beforeEach(() => { f = context.f; controller = context.controller; });
  it.each(PROVISION_ROWS.mixedBackend)('pins explicitly selected mixed-backend identity and defaults on %s', async mode => {
    const home = join(f.root, 'codex-account'); mkdirSync(home); vi.stubEnv('CODEX_HOME', home);
    writeFileSync(join(home, 'config.toml'), 'model = "gpt-5.1-codex"');
    const a = await acceptIdentityWorker(undefined, { allowedTools: [], bashAllowlist: [] }, { backend: 'codex', context: { text: 'selected context only' } });
    expect(f.store.readWorkerIdentity(a.child.workerId)).toMatchObject({ account: { provider: 'codex', homePath: home }, model: 'gpt-5.1-codex', grants: { allowedTools: [], bashAllowlist: [] } });
    writeFileSync(join(home, 'config.toml'), 'model = "gpt-5.1-codex-mini"');
    await launchAccepted(a, mode); await until(() => sessions.length === 2);
    expect(sessions[1]!.spec.userPrompt).toContain('selected context only');
    if (mode === 'continue') {
      sessions[1]!.finish(); expect(await f.manager.awaitRunTermination(a.child.workerId, 15000)).toBe(true);
      expect(f.manager.continueRun(a.child.workerId, { text: 'again' }).ok).toBe(true); await until(() => sessions.length === 3);
    }
    expect(sessions.at(-1)!.spec).toMatchObject({ restrictCrossSessionMessaging: true, model: 'gpt-5.1-codex', toolGrant: { kind: 'inherited', tools: [], bashAllowlist: [] } });
    expect(sessions.at(-1)!.spec.effort).toBeUndefined();
    expect(sessions.at(-1)!.spec.env?.CODEX_HOME).toBe(home);
    expect(sessions.at(-1)!.spec.env?.CEZ_DELEGATION_TOKEN).not.toBe(sessions[0]!.spec.env?.CEZ_DELEGATION_TOKEN);
  });
  it.each(PROVISION_ROWS.mixedChain)('runs a mixed-runner chain with each agent step under its own account, model and grants on %s (#452)', async mode => {
    const codexHome = join(f.root, 'codex-account'); mkdirSync(codexHome); vi.stubEnv('CODEX_HOME', codexHome);
    writeFileSync(join(codexHome, 'config.toml'), 'model = "gpt-5.1-codex"');
    const dir = join(f.root, '.ai/cezar/workflows'); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'mixed.yaml'), ['name: mixed', 'steps:',
      '  - id: implement', '    prompt: "Implement: {{task}}"', '    runner: codex', '    allowedTools: [Read]',
      '  - id: review', '    prompt: "Review: {{task}}"', '    runner: claude'].join('\n'));
    const a = await acceptIdentityWorker(undefined, undefined, { workflow: 'mixed' });
    const worker = f.store.getRun(a.child.workerId)!;
    // Run-level columns follow the first agent step; the identity pins both.
    expect(worker).toMatchObject({ runner: 'codex', model: 'gpt-5.1-codex', agentProfile: 'default' });
    expect(worker.effort).toBeUndefined();
    expect(f.store.readWorkerIdentity(worker.id)).toMatchObject({ account: { provider: 'codex', homePath: codexHome }, steps: [
      { stepId: 'implement', account: { provider: 'codex', profileId: 'default', homePath: codexHome }, model: 'gpt-5.1-codex', grants: { allowedTools: ['Read'] } },
      { stepId: 'review', account: { provider: 'claude', profileId: 'account-a', homePath: a.home }, model: 'haiku', effort: 'high' },
    ] });
    const { store } = await launchAccepted(a, mode === 'continue' ? 'queued' : mode);
    await until(() => sessions.length === 2);
    const implement = sessions[1]!.spec;
    expect(implement.userPrompt).toContain('Implement: child');
    expect(implement).toMatchObject({ model: 'gpt-5.1-codex', toolGrant: { kind: 'inherited', tools: ['Read'] } });
    expect(implement.effort).toBeUndefined();
    expect(implement.env?.CODEX_HOME).toBe(codexHome);
    expect(implement.env?.CLAUDE_CONFIG_DIR).not.toBe(a.home);
    doneTurn(sessions[1]!, 'implemented');
    await until(() => sessions.length === 3);
    const review = sessions[2]!.spec;
    expect(review.userPrompt).toContain('Review: child');
    expect(review).toMatchObject({ model: 'haiku', effort: 'high' });
    // The identity pins the parent's lists, so the worker step resolves them as inherited.
    expect(review.toolGrant).toEqual({ ...sessions[0]!.spec.toolGrant, kind: 'inherited' });
    expect(review.env?.CLAUDE_CONFIG_DIR).toBe(a.home);
    expect(review.env?.CODEX_HOME).not.toBe(codexHome);
    expect(store.getRun(worker.id)?.steps.map(step => ({ id: step.id, backend: step.backend, profileId: step.profileId }))).toEqual([
      { id: 'implement', backend: 'codex', profileId: 'default' }, { id: 'review', backend: 'claude', profileId: 'account-a' },
    ]);
    if (mode !== 'continue') return;
    sessions[2]!.emit({ type: 'session', sessionId: 'review-session', resumed: false }); sessions[2]!.finish('reviewed');
    expect(await f.manager.awaitRunTermination(worker.id, 15000)).toBe(true);
    // A Continue extends the LAST agent step, so it resumes under that step's identity, not the run-level codex one.
    expect(f.manager.continueRun(worker.id, { text: 'again', runner: 'codex' })).toMatchObject({ ok: false, error: expect.stringContaining('identity') });
    expect(f.manager.continueRun(worker.id, { text: 'again' }).ok).toBe(true);
    await until(() => sessions.length === 4);
    expect(sessions[3]!.spec).toMatchObject({ model: 'haiku', effort: 'high', resume: true, sessionId: 'review-session' });
    expect(sessions[3]!.spec.env?.CLAUDE_CONFIG_DIR).toBe(a.home);
    expect(sessions[3]!.spec.env?.CODEX_HOME).not.toBe(codexHome);
  });
  // hearsay-tools/cezarion#2991: Codex mints its own session id, so the launch UUID on a step whose
  // process ended before Codex reported a session cannot be resumed. The Continue opens a fresh
  // Codex session and still runs as that step, under its pinned identity.
  it('continues a mixed chain whose codex step ended before its session event as that step, in a fresh session', async () => {
    const codexHome = join(f.root, 'codex-account'); mkdirSync(codexHome); vi.stubEnv('CODEX_HOME', codexHome);
    writeFileSync(join(codexHome, 'config.toml'), 'model = "gpt-5.1-codex"');
    const dir = join(f.root, '.ai/cezar/workflows'); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'mixed.yaml'), ['name: mixed', 'steps:',
      '  - id: implement', '    prompt: "Implement: {{task}}"', '    runner: codex', '    allowedTools: [Read]',
      '  - id: review', '    prompt: "Review: {{task}}"', '    runner: claude'].join('\n'));
    const a = await acceptIdentityWorker(undefined, undefined, { workflow: 'mixed' });
    await launchAccepted(a, 'queued'); await until(() => sessions.length === 2);
    const launchId = f.store.getRun(a.child.workerId)!.steps.find(step => step.id === 'implement')!.sessionId;
    expect(launchId).toBeDefined();
    sessions[1]!.finish();
    expect(await f.manager.awaitRunTermination(a.child.workerId, 15000)).toBe(true);
    expect(f.manager.continueRun(a.child.workerId, { text: 'again' })).toEqual({ ok: true });
    await until(() => sessions.length === 3 || f.store.getRun(a.child.workerId)?.status === 'failed');
    expect(f.store.getRun(a.child.workerId)?.error).toBeUndefined();
    const continued = sessions[2]!.spec;
    expect(continued.resume).toBeFalsy();
    expect(continued.sessionId).not.toBe(launchId);
    expect(continued).toMatchObject({ model: 'gpt-5.1-codex', toolGrant: { kind: 'inherited', tools: ['Read'] } });
    expect(continued.env?.CODEX_HOME).toBe(codexHome);
  }, 60_000);
  // hearsay-tools/squawk#3024: the fresh Codex session of that Continue belongs to the synthetic
  // `continue-1`. When its process ends, the next Continue still runs as `implement`, under its
  // pinned Codex identity, not as the chain's last agent step `review` on Claude.
  it('continues a crashed synthetic continuation of a mixed chain\'s codex step as that step', async () => {
    const codexHome = join(f.root, 'codex-account'); mkdirSync(codexHome); vi.stubEnv('CODEX_HOME', codexHome);
    writeFileSync(join(codexHome, 'config.toml'), 'model = "gpt-5.1-codex"');
    const dir = join(f.root, '.ai/cezar/workflows'); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'mixed.yaml'), ['name: mixed', 'steps:',
      '  - id: implement', '    prompt: "Implement: {{task}}"', '    runner: codex', '    allowedTools: [Read]',
      '  - id: review', '    prompt: "Review: {{task}}"', '    runner: claude'].join('\n'));
    const a = await acceptIdentityWorker(undefined, undefined, { workflow: 'mixed' });
    const workerId = a.child.workerId;
    await launchAccepted(a, 'queued'); await until(() => sessions.length === 2);
    sessions[1]!.finish();
    expect(await f.manager.awaitRunTermination(workerId, 15000)).toBe(true);
    expect(f.manager.continueRun(workerId, { text: 'again' })).toEqual({ ok: true });
    await until(() => sessions.length === 3);
    sessions[2]!.emit({ type: 'session', sessionId: 'continue-thread', resumed: false });
    await until(() => f.store.getRun(workerId)?.steps.find(step => step.id === 'continue-1')?.sessionId === 'continue-thread');
    expect(f.store.getRun(workerId)?.steps.find(step => step.id === 'continue-1')).toMatchObject({ synthetic: 'continuation', continuesStepId: 'implement' });
    // continue-1's process ends before `review` starts. The next Continue resumes its session.
    sessions[2]!.finish();
    expect(await f.manager.awaitRunTermination(workerId, 15000)).toBe(true);
    expect(f.manager.continueRun(workerId, { text: 'again' })).toEqual({ ok: true });
    await until(() => sessions.length === 4 || f.store.getRun(workerId)?.status === 'failed');
    expect(f.store.getRun(workerId)?.error).toBeUndefined();
    const continued = sessions[3]!.spec;
    expect(continued).toMatchObject({ resume: true, sessionId: 'continue-thread', model: 'gpt-5.1-codex', toolGrant: { kind: 'inherited', tools: ['Read'] } });
    expect(continued.effort).toBeUndefined();
    expect(continued.env?.CODEX_HOME).toBe(codexHome);
    expect(continued.env?.CLAUDE_CONFIG_DIR).not.toBe(a.home);
    expect(f.store.getRun(workerId)?.steps.find(step => step.id === 'continue-2')).toMatchObject({ synthetic: 'continuation', continuesStepId: 'implement' });
  }, 60_000);
  // Review round 1 of hearsay-tools/squawk#3024: `review` ran after `continue-1`, which the record
  // lists after it. The latest session is review's, so the next Continue runs as `review`.
  it('continues a mixed chain as review after a continuation of implement advanced it', async () => {
    const codexHome = join(f.root, 'codex-account'); mkdirSync(codexHome); vi.stubEnv('CODEX_HOME', codexHome);
    writeFileSync(join(codexHome, 'config.toml'), 'model = "gpt-5.1-codex"');
    const dir = join(f.root, '.ai/cezar/workflows'); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'mixed.yaml'), ['name: mixed', 'steps:',
      '  - id: implement', '    prompt: "Implement: {{task}}"', '    runner: codex', '    allowedTools: [Read]',
      '  - id: review', '    prompt: "Review: {{task}}"', '    runner: claude'].join('\n'));
    const a = await acceptIdentityWorker(undefined, undefined, { workflow: 'mixed' });
    const workerId = a.child.workerId;
    await launchAccepted(a, 'queued'); await until(() => sessions.length === 2);
    sessions[1]!.finish();
    expect(await f.manager.awaitRunTermination(workerId, 15000)).toBe(true);
    expect(f.manager.continueRun(workerId, { text: 'again' })).toEqual({ ok: true });
    await until(() => sessions.length === 3);
    sessions[2]!.emit({ type: 'session', sessionId: 'continue-thread', resumed: false });
    await until(() => f.store.getRun(workerId)?.steps.find(step => step.id === 'continue-1')?.sessionId === 'continue-thread');
    doneTurn(sessions[2]!, 'implemented');
    await until(() => sessions.length === 4);
    expect(sessions[3]!.spec.userPrompt).toContain('Review: child');
    sessions[3]!.emit({ type: 'session', sessionId: 'review-session', resumed: false });
    await until(() => f.store.getRun(workerId)?.steps.find(step => step.id === 'review')?.sessionId === 'review-session');
    sessions[3]!.finish('reviewed');
    expect(await f.manager.awaitRunTermination(workerId, 15000)).toBe(true);
    expect(f.store.getRun(workerId)?.steps.map(step => step.id)).toEqual(['implement', 'review', 'continue-1']);
    expect(f.manager.continueRun(workerId, { text: 'again' })).toEqual({ ok: true });
    await until(() => sessions.length === 5 || f.store.getRun(workerId)?.status === 'failed');
    expect(f.store.getRun(workerId)?.error).toBeUndefined();
    expect(sessions[4]!.spec).toMatchObject({ model: 'haiku', effort: 'high', resume: true, sessionId: 'review-session' });
    expect(sessions[4]!.spec.env?.CLAUDE_CONFIG_DIR).toBe(a.home);
    expect(sessions[4]!.spec.env?.CODEX_HOME).not.toBe(codexHome);
    expect(f.store.getRun(workerId)?.steps.find(step => step.id === 'continue-2')).toMatchObject({ continuesStepId: 'review' });
  }, 60_000);
  // Review round 1 of hearsay-tools/squawk#3024: a Continue recovered a failed `implement` through its
  // `resume` cursor, which keeps that attempt failed, and the chain went on to `verify`. A later
  // Continue of that session must not run `verify` again.
  it('does not run the rest of a chain again after a continuation of a recovered failed step', async () => {
    const dir = join(f.root, '.ai/cezar/workflows'); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'checked.yaml'), ['name: checked', 'steps:',
      '  - id: implement', '    prompt: "Implement: {{task}}"', '  - id: verify', '    command: "true"'].join('\n'));
    const a = await acceptIdentityWorker(undefined, undefined, { workflow: 'checked' });
    const workerId = a.child.workerId;
    await launchAccepted(a, 'queued'); await until(() => sessions.length === 2);
    sessions[1]!.emit({ type: 'session', sessionId: 'implement-session', resumed: false });
    await until(() => f.store.getRun(workerId)?.steps.find(step => step.id === 'implement')?.sessionId === 'implement-session');
    doneTurn(sessions[1]!, 'implemented');
    expect(await f.manager.awaitRunTermination(workerId, 15000)).toBe(true);
    const verifyStarts = () => f.store.readEvents(workerId).filter(event => event.type === 'step-start' && event.stepId === 'verify').length;
    expect(verifyStarts()).toBe(1);
    // What that recovery leaves: the failed attempt, and the done `continue-1` that resumed its
    // session and recorded it, between `implement` and `verify`.
    const implement = f.store.getRun(workerId)!.steps.find(step => step.id === 'implement')!;
    f.store.updateStep(workerId, 'implement', { status: STEP_STATUS.failed, error: 'boom' });
    f.store.addStep(workerId, { id: 'continue-1', name: 'Continue', kind: STEP_KIND.agent, synthetic: 'continuation', continuesStepId: 'implement' });
    f.store.updateStep(workerId, 'continue-1', { status: STEP_STATUS.done, iterations: 1, startedAt: implement.startedAt, sessionId: 'implement-session', backend: 'claude', profileId: implement.profileId });
    expect(f.manager.continueRun(workerId, { text: 'again' })).toEqual({ ok: true });
    await until(() => sessions.length === 3);
    expect(sessions[2]!.spec).toMatchObject({ resume: true, sessionId: 'implement-session' });
    doneTurn(sessions[2]!, 'answered');
    await until(() => verifyStarts() > 1 || (!f.manager.isActive(workerId) && ['done', 'review', 'failed'].includes(f.store.getRun(workerId)?.status ?? '')));
    expect(verifyStarts()).toBe(1);
    expect(f.store.getRun(workerId)?.error).toBeUndefined();
  }, 60_000);
  // Review round 2 of hearsay-tools/squawk#3024: `continuesStepId` names the step a Continue runs
  // as, never the workflow position. A Continue after a recovered failed final step leaves that
  // attempt failed and starts nothing.
  it('leaves a recovered failed final step failed after a later continuation of it', async () => {
    const dir = join(f.root, '.ai/cezar/workflows'); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'single.yaml'), ['name: single', 'steps:', '  - id: implement', '    prompt: "Implement: {{task}}"'].join('\n'));
    const a = await acceptIdentityWorker(undefined, undefined, { workflow: 'single' });
    const workerId = a.child.workerId;
    await launchAccepted(a, 'queued'); await until(() => sessions.length === 2);
    sessions[1]!.emit({ type: 'session', sessionId: 'implement-session', resumed: false });
    await until(() => f.store.getRun(workerId)?.steps.find(step => step.id === 'implement')?.sessionId === 'implement-session');
    doneTurn(sessions[1]!, 'implemented');
    expect(await f.manager.awaitRunTermination(workerId, 15000)).toBe(true);
    // What the recovery leaves: the failed attempt, and the done `continue-1` that resumed its
    // session through the `resume` cursor and recorded it.
    const implement = f.store.getRun(workerId)!.steps.find(step => step.id === 'implement')!;
    const failedAt = '2026-11-16T00:00:00.000Z';
    f.store.updateStep(workerId, 'implement', { status: STEP_STATUS.failed, error: 'boom', finishedAt: failedAt });
    f.store.addStep(workerId, { id: 'continue-1', name: 'Continue', kind: STEP_KIND.agent, synthetic: 'continuation', continuesStepId: 'implement' });
    f.store.updateStep(workerId, 'continue-1', { status: STEP_STATUS.done, iterations: 1, startedAt: implement.startedAt, sessionId: 'implement-session', backend: 'claude', profileId: implement.profileId });
    const implementStarts = () => f.store.readEvents(workerId).filter(event => event.type === 'step-start' && event.stepId === 'implement').length;
    expect(f.manager.continueRun(workerId, { text: 'again' })).toEqual({ ok: true });
    await until(() => sessions.length === 3);
    expect(sessions[2]!.spec).toMatchObject({ resume: true, sessionId: 'implement-session' });
    doneTurn(sessions[2]!, 'answered');
    expect(await f.manager.awaitRunTermination(workerId, 15000)).toBe(true);
    expect(f.store.getRun(workerId)?.error).toBeUndefined();
    expect(f.store.getRun(workerId)?.steps.find(step => step.id === 'implement')).toMatchObject({ status: STEP_STATUS.failed, error: 'boom', finishedAt: failedAt });
    expect(implementStarts()).toBe(1);
  }, 60_000);
  it('launches a later step under its own account even after the first step\'s account home is gone (#465 review)', async () => {
    const codexHome = join(f.root, 'codex-account'); mkdirSync(codexHome); vi.stubEnv('CODEX_HOME', codexHome);
    const dir = join(f.root, '.ai/cezar/workflows'); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'mixed.yaml'), ['name: mixed', 'steps:',
      '  - id: implement', '    prompt: "Implement: {{task}}"', '    runner: codex',
      '  - id: review', '    prompt: "Review: {{task}}"', '    runner: claude'].join('\n'));
    const a = await acceptIdentityWorker(undefined, undefined, { workflow: 'mixed' });
    await launchAccepted(a, 'queued'); await until(() => sessions.length === 2);
    expect(sessions[1]!.spec.env?.CODEX_HOME).toBe(codexHome);
    // The codex login is removed once its step is over. The claude step's own pinned account is intact.
    rmSync(codexHome, { recursive: true, force: true });
    doneTurn(sessions[1]!, 'implemented');
    await until(() => sessions.length === 3 || f.store.getRun(a.child.workerId)?.status === 'failed');
    expect(f.store.getRun(a.child.workerId)?.error).toBeUndefined();
    expect(sessions[2]!.spec.userPrompt).toContain('Review: child');
    expect(sessions[2]!.spec.env?.CLAUDE_CONFIG_DIR).toBe(a.home);
  });
  // Round 2 of #465: a completed mixed chain whose FIRST step's login is gone must still Continue
  // and recover into its LAST step's account, live and across a restart.
  async function finishedMixedChain() {
    const codexHome = join(f.root, 'codex-account'); mkdirSync(codexHome); vi.stubEnv('CODEX_HOME', codexHome);
    const dir = join(f.root, '.ai/cezar/workflows'); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'mixed.yaml'), ['name: mixed', 'steps:',
      '  - id: implement', '    prompt: "Implement: {{task}}"', '    runner: codex',
      '  - id: review', '    prompt: "Review: {{task}}"', '    runner: claude'].join('\n'));
    const a = await acceptIdentityWorker(undefined, undefined, { workflow: 'mixed' });
    await launchAccepted(a, 'queued'); await until(() => sessions.length === 2);
    doneTurn(sessions[1]!, 'implemented'); await until(() => sessions.length === 3);
    sessions[2]!.emit({ type: 'session', sessionId: 'review-session', resumed: false }); sessions[2]!.finish('reviewed');
    expect(await f.manager.awaitRunTermination(a.child.workerId, 15000)).toBe(true);
    rmSync(codexHome, { recursive: true, force: true });
    return { a, codexHome };
  }
  // finishedMixedChain already awaits two 15s until()s plus a 15s termination; the cell then
  // waits again. Isolated recovery is ~1s; CI on #959 hit 16338ms against the 15s describe
  // (#960). Cover the sequential waits rather than the observed 16s.
  it('continues a mixed chain into its last step\'s account after the first step\'s account home is gone (#465 review)', async () => {
    const { a } = await finishedMixedChain();
    expect(f.manager.continueRun(a.child.workerId, { text: 'again' }).ok).toBe(true);
    await until(() => sessions.length === 4 || f.store.getRun(a.child.workerId)?.status === 'failed');
    expect(f.store.getRun(a.child.workerId)?.error).toBeUndefined();
    expect(sessions[3]!.spec).toMatchObject({ resume: true, sessionId: 'review-session' });
    expect(sessions[3]!.spec.env?.CLAUDE_CONFIG_DIR).toBe(a.home);
  }, 60_000);
  it('recovers a queued continuation of a mixed chain onto its last step\'s runner and session (#465 review)', async () => {
    const { a } = await finishedMixedChain();
    // The durable shape a crash leaves behind after a continuation was accepted but not yet
    // launched: a pending synthetic `continue-1` step and its message, on a `queued` record.
    const worker = f.store.getRun(a.child.workerId)!;
    f.store.addStep(worker.id, { id: 'continue-1', name: 'Continue', kind: STEP_KIND.agent, synthetic: 'continuation' });
    setRunStatus(f.store, worker.id, RUN_STATUS.queued, { finishedAt: undefined, continuationMessage: { id: 'continue-1', text: 'again', origin: 'human', createdAt: new Date().toISOString() } });
    f.manager.dispose(); sessions[0]!.finish();
    setRunStatus(f.store, a.parent.id, RUN_STATUS.waiting); f.store.close();
    const store = openTestRunStore(join(f.root, '.ai/cezar'), { keepLive: true });
    const manager = createFixtureManager(store, f.root); recoveredManagers.push(manager); recoveredStores.push(store);
    controller.attachProject({ home: testHome(), id: 'restarted', root: f.root, store, manager });
    await manager.recover();
    await until(() => sessions.length === 4 || store.getRun(worker.id)?.status === 'failed');
    expect(store.getRun(worker.id)?.error).toBeUndefined();
    // Reconstructed from the review step's pinned identity, not the run-level codex one: the
    // claude session is resumed, under the claude account.
    expect(sessions[3]!.spec).toMatchObject({ resume: true, sessionId: 'review-session' });
    expect(sessions[3]!.spec.env?.CLAUDE_CONFIG_DIR).toBe(a.home);
    expect(sessions[3]!.spec.env?.CODEX_HOME).toBeUndefined();
  }, 60_000);
  it.each(PROVISION_ROWS.legacyIdentity)('still runs a single-runner worker whose identity evidence predates per-step entries on %s (#452)', async mode => {
    const a = await acceptIdentityWorker();
    // Evidence written before #452 carries only the run-level fields.
    const path = join(f.root, '.ai/cezar/runs', `${a.child.workerId}.identity.json`);
    const { steps: _steps, ...legacy } = JSON.parse(readFileSync(path, 'utf8'));
    expect(_steps).toHaveLength(1); writeFileSync(path, JSON.stringify(legacy));
    expect(f.store.readWorkerIdentity(a.child.workerId)).not.toHaveProperty('steps');
    await launchAccepted(a, mode); await until(() => sessions.length === 2);
    if (mode === 'continue') {
      sessions[1]!.finish(); expect(await f.manager.awaitRunTermination(a.child.workerId, 15000)).toBe(true);
      expect(f.manager.continueRun(a.child.workerId, { text: 'again' }).ok).toBe(true); await until(() => sessions.length === 3);
    }
    expect(sessions.at(-1)!.spec).toMatchObject({ model: 'haiku', effort: 'high' });
    expect(sessions.at(-1)!.spec.env?.CLAUDE_CONFIG_DIR).toBe(a.home);
  });
});
