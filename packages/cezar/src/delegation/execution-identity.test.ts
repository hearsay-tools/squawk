import { sealTestRunners } from '../core/runner-registry.testkit.ts';
import { claudeRunner } from '../runners/claude/definition.ts';
import { codexRunner } from '../runners/codex/definition.ts';
import { piRunner } from '../runners/pi/definition.ts';
import { ompRunner } from '../runners/omp/definition.ts';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  acceptedWorkerIdentitySchema, boundWorkerAccountEnv, captureWorkerAccount, ownedWorkflow, patchWorkerIdentity,
  readWorkerIdentity, resolveWorkerIdentity, updateWorkerIdentity, workerAccountBindingSchema,
  workerExecutionIdentitySchema, workerStepIdentity, workerWorkflowHash, WorkerIdentityError,
  type AcceptedWorkerIdentity,
} from './execution-identity.ts';
import type { RunRecord } from '../runs/store.ts';
import type { ResolvedAgentProfile } from '../workspace/agent-profiles.ts';

sealTestRunners(claudeRunner, codexRunner, piRunner, ompRunner);

// The cases bind accounts of several providers; the schema reads each one's account layout from the registry.

const claude = { provider: 'claude' as const, profileId: 'default', homePath: '/home/x/.claude', claudeLayout: { kind: 'relocated' as const } };
const codex = { provider: 'codex' as const, profileId: 'work', homePath: '/home/x/codex-work' };
const runLevel = { kind: 'accepted' as const, account: claude, grants: { allowedTools: ['Read'] }, model: 'opus', effort: 'high' };

describe('per-step worker identity (#452)', () => {
  it('still loads evidence written before per-step entries existed and answers every step with the run-level view', () => {
    const identity = workerExecutionIdentitySchema.parse(JSON.parse(JSON.stringify(runLevel))) as AcceptedWorkerIdentity;
    expect(identity).not.toHaveProperty('steps');
    for (const stepId of ['task', 'inspect', 'continue-3']) {
      expect(workerStepIdentity(identity, stepId)).toEqual({ account: claude, grants: { allowedTools: ['Read'] }, model: 'opus', effort: 'high' });
    }
  });
  it('pins one account, model, effort and grant set per agent step', () => {
    const identity = acceptedWorkerIdentitySchema.parse({ ...runLevel, steps: [
      { stepId: 'implement', account: codex, grants: { allowedTools: [] }, model: 'gpt-5.1-codex' },
      { stepId: 'review', account: claude, grants: { allowedTools: ['Read'], bashAllowlist: ['git diff'] }, model: 'opus', effort: 'high' },
    ] });
    expect(workerStepIdentity(identity, 'implement')).toEqual({ account: codex, grants: { allowedTools: [] }, model: 'gpt-5.1-codex' });
    expect(workerStepIdentity(identity, 'review')).toMatchObject({ account: claude, effort: 'high', grants: { bashAllowlist: ['git diff'] } });
    // Explicit entries are authority: a step the acceptance never saw has no identity to run under.
    expect(() => workerStepIdentity(identity, 'verify')).toThrow(WorkerIdentityError);
  });
  it('rejects a step entry with unknown keys or a missing grant record', () => {
    expect(acceptedWorkerIdentitySchema.safeParse({ ...runLevel, steps: [{ stepId: 'a', account: claude, grants: {}, extra: 1 }] }).success).toBe(false);
    expect(acceptedWorkerIdentitySchema.safeParse({ ...runLevel, steps: [{ stepId: 'a', account: claude }] }).success).toBe(false);
    expect(acceptedWorkerIdentitySchema.safeParse({ ...runLevel, steps: [] }).success).toBe(false);
  });
  it('patches same-runner model and effort on legacy, first-step and later-step identities without altering account or grants', () => {
    const legacy = acceptedWorkerIdentitySchema.parse(runLevel);
    const baseRun = { id: 'r1', runner: 'claude', model: 'opus', effort: 'high' } as unknown as RunRecord;
    const legacyPatched = patchWorkerIdentity(baseRun, legacy, undefined, { model: 'sonnet', effort: '' });
    expect(legacyPatched?.identity).toEqual({ ...legacy, model: 'sonnet', effort: undefined });
    expect(legacyPatched?.runPatch).toEqual({ model: 'sonnet', effort: undefined, modelIdentity: undefined });
    expect(patchWorkerIdentity(baseRun, legacy, undefined, { model: 'opus', effort: 'high' })).toBeUndefined();

    const workflowDef = {
      name: 'mixed',
      source: 'file' as const,
      steps: [
        { id: 'implement', prompt: 'impl', runner: 'codex', agentProfile: 'work', model: 'gpt-5.1-codex', allowedTools: [] },
        { id: 'review', prompt: 'rev', runner: 'claude', agentProfile: 'default', model: 'opus', effort: 'high', allowedTools: ['Read'] },
      ],
    };
    const multi = acceptedWorkerIdentitySchema.parse({
      kind: 'accepted',
      account: codex,
      grants: { allowedTools: [] },
      model: 'gpt-5.1-codex',
      workflowHash: workerWorkflowHash(workflowDef),
      steps: [
        { stepId: 'implement', account: codex, grants: { allowedTools: [] }, model: 'gpt-5.1-codex' },
        { stepId: 'review', account: claude, grants: { allowedTools: ['Read'] }, model: 'opus', effort: 'high' },
      ],
    });
    const multiRun = { id: 'r2', runner: 'codex', model: 'gpt-5.1-codex', workflowDef } as unknown as RunRecord;
    const step2 = patchWorkerIdentity(multiRun, multi, 'review', { model: 'sonnet', effort: 'low' })!;
    expect(step2.identity.model).toBe('gpt-5.1-codex');
    expect(step2.identity.account).toEqual(codex);
    expect(step2.identity.steps![0]).toEqual(multi.steps![0]);
    expect(step2.identity.steps![1]).toEqual({ stepId: 'review', account: claude, grants: { allowedTools: ['Read'] }, model: 'sonnet', effort: 'low' });
    expect(step2.runPatch.model).toBeUndefined();
    expect(step2.runPatch.workflowDef?.steps[1]).toMatchObject({ id: 'review', model: 'sonnet', effort: 'low' });
    expect(step2.identity.workflowHash).toBe(workerWorkflowHash(step2.runPatch.workflowDef!));

    const step1 = patchWorkerIdentity(multiRun, multi, 'implement', { model: 'gpt-5.1-codex-mini', effort: 'medium' })!;
    expect(step1.identity.model).toBe('gpt-5.1-codex-mini');
    expect(step1.identity.effort).toBe('medium');
    expect(step1.runPatch).toMatchObject({ model: 'gpt-5.1-codex-mini', effort: 'medium' });
    expect(step1.identity.workflowHash).toBe(workerWorkflowHash(step1.runPatch.workflowDef!));
  });

  it('recovers crash-staged pending overrides against either pre-commit or post-commit runs.db state', () => {
    const workflowDef = {
      name: 'mixed',
      source: 'file' as const,
      steps: [
        { id: 'implement', prompt: 'impl', runner: 'codex', agentProfile: 'work', model: 'gpt-5.1-codex', allowedTools: [] },
        { id: 'review', prompt: 'rev', runner: 'claude', agentProfile: 'default', model: 'opus', effort: 'high', allowedTools: ['Read'] },
      ],
    };
    const previous = acceptedWorkerIdentitySchema.parse({
      kind: 'accepted',
      account: codex,
      grants: { allowedTools: [] },
      model: 'gpt-5.1-codex',
      workflowHash: workerWorkflowHash(workflowDef),
      steps: [
        { stepId: 'implement', account: codex, grants: { allowedTools: [] }, model: 'gpt-5.1-codex' },
        { stepId: 'review', account: claude, grants: { allowedTools: ['Read'] }, model: 'opus', effort: 'high' },
      ],
    });
    const beforeRun = { id: 'r-crash', runner: 'codex', agentProfile: 'work', model: 'gpt-5.1-codex', workflowDef } as unknown as RunRecord;
    const patched = patchWorkerIdentity(beforeRun, previous, 'review', { model: 'sonnet', effort: 'low' })!;
    const staged = acceptedWorkerIdentitySchema.parse({ ...previous, pending: patched.pending });
    const afterRun = { ...beforeRun, ...patched.runPatch } as unknown as RunRecord;

    // Crash BEFORE runs.db commit: base identity still matches and stays active.
    expect(resolveWorkerIdentity(beforeRun, staged)).toEqual(previous);
    expect(ownedWorkflow(beforeRun, staged)).toEqual(workflowDef);

    // Crash AFTER runs.db commit, BEFORE finalize: pending identity matches and becomes active.
    expect(resolveWorkerIdentity(afterRun, staged)).toEqual(patched.identity);
    expect(ownedWorkflow(afterRun, staged)).toEqual(patched.runPatch.workflowDef);

    // Subsequent override from a staged record strips `pending` rather than nesting it.
    const nextPatch = patchWorkerIdentity(afterRun, staged, 'review', { model: 'haiku' })!;
    expect(nextPatch.identity).not.toHaveProperty('pending');
    expect(nextPatch.identity.steps![1]?.model).toBe('haiku');

    // Compact pending stays tiny even on a large 16.5 KiB identity and round-trips through disk.
    const bigTools = Array.from({ length: 81 }, (_, i) => `mcp__very_long_server_namespace_${i}__tool_action_name_${'x'.repeat(140)}`);
    const large = acceptedWorkerIdentitySchema.parse({ ...previous, grants: { allowedTools: bigTools }, steps: [
      { stepId: 'implement', account: codex, grants: { allowedTools: bigTools }, model: 'gpt-5.1-codex' },
      { stepId: 'review', account: claude, grants: { allowedTools: ['Read'] }, model: 'opus', effort: 'high' },
    ] });
    const largePatch = patchWorkerIdentity(beforeRun, large, 'review', { model: 'sonnet', effort: 'low' })!;
    const largeStaged = acceptedWorkerIdentitySchema.parse({ ...large, pending: largePatch.pending });
    expect(Buffer.byteLength(JSON.stringify(largeStaged), 'utf8') - Buffer.byteLength(JSON.stringify(large), 'utf8')).toBeLessThan(256);
    const dir = mkdtempSync(join(tmpdir(), 'cez-large-identity-'));
    try {
      const execs = { identityPath: (id: string) => join(dir, `${id}.identity.json`) };
      updateWorkerIdentity(execs, 'large-worker', largeStaged);
      expect(readWorkerIdentity(execs, 'large-worker')).toEqual(largeStaged);
    } finally { rmSync(dir, { recursive: true, force: true }); }

    // Tampered runs.db matching neither base nor pending is still rejected.
    const tampered = { ...beforeRun, model: 'unauthorized-model' } as unknown as RunRecord;
    expect(resolveWorkerIdentity(tampered, staged)).toEqual(previous);
    const tamperedWorkflow = { ...beforeRun, workflowDef: { ...workflowDef, steps: [workflowDef.steps[0]!] } } as unknown as RunRecord;
    expect(() => ownedWorkflow(tamperedWorkflow, staged)).toThrow(WorkerIdentityError);
  });
});

describe('pi and omp worker accounts', () => {
  let root: string;
  beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'cez-worker-account-'))); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const profile = (provider: 'pi' | 'omp', id: string, path: string): ResolvedAgentProfile =>
    ({ id, provider, label: id, configDir: path, path, isDefault: id === 'default' });

  it('pins a pi account to its folder and spawns it there', () => {
    const dir = join(root, 'pi-work'); mkdirSync(dir);
    const binding = captureWorkerAccount(profile('pi', 'work', dir))!;
    expect(binding).toEqual({ provider: 'pi', profileId: 'work', homePath: dir });
    expect(boundWorkerAccountEnv(binding)).toEqual({ PI_CODING_AGENT_DIR: dir });
  });

  it('binds the discovered pi and omp account with no home, so it launches where the agent never ran', () => {
    // Pinning a home requires it to exist at launch, and a machine where pi or omp has never run
    // has none, so their default workers spawn bare.
    for (const provider of ['pi', 'omp'] as const) {
      const binding = captureWorkerAccount(profile(provider, 'default', join(root, 'never-created', provider)))!;
      expect(binding, provider).toEqual({ provider, profileId: 'default' });
      expect(boundWorkerAccountEnv(binding), provider).toEqual({});
    }
  });

  it('loads a home-less default binding for pi and omp and spawns it bare', () => {
    for (const provider of ['pi', 'omp'] as const) {
      const legacy = workerAccountBindingSchema.parse({ provider, profileId: 'default' });
      expect(boundWorkerAccountEnv(legacy)).toEqual({});
    }
    // A NAMED account always pins its home, and Claude and Codex never had a home-less form.
    expect(workerAccountBindingSchema.safeParse({ provider: 'pi', profileId: 'work' }).success).toBe(false);
    // omp carries no named accounts, so an omp binding never pins a home.
    expect(workerAccountBindingSchema.safeParse({ provider: 'omp', profileId: 'work', homePath: '/home/x/.omp/profiles/work' }).success).toBe(false);
    expect(workerAccountBindingSchema.safeParse({ provider: 'codex', profileId: 'default' }).success).toBe(false);
  });
});
