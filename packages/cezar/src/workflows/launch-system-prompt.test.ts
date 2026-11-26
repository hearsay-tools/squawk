import '../built-in-launch-parts.testkit.ts';
import { sealTestRunners } from '../core/runner-registry.testkit.ts';
import { fakeRunnerFactory } from '../core/fake-runner-factory.testkit.ts';
import { useRunners } from '../core/runners-under-test.testkit.ts';
import { testHome } from '../home/test-home.testkit.ts';
import { createFixtureManager, drainFixtureManagers } from './fixture-manager.testkit.ts';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { artifactInstructions } from '../artifacts/lifecycle.ts';
import { jobInstructions } from '../jobs/command.ts';
import { automationCliCommand, automationsPrompt } from '../automations/prompts.ts';
import type { AgentRunSpec } from '../core/agent-runner.ts';
import { handoffInstructions } from '../handoff.ts';
import { RunStore } from '../runs/store.ts';
import { agentWebhooksPrompt, webhookCliCommand } from '../webhooks/prompt.ts';
import { mergeWriteWorkspaceConfig } from '../workspace/config.ts';
import { registerProject } from '../workspace/projects.ts';
import { registryEntry } from '../workspace/registry-entry.ts';
import { agentWebhooks } from '../workspace/webhooks.ts';
import type { RunManager } from './run.ts';
import { fixedSkillCatalog } from '../core/runner-skill-fixture.testkit.ts';
import type { WorkflowDef } from './types.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/** Every spec the runner seam receives, and how the stub runner treats a resumed system prompt. */
const launched = vi.hoisted(() => ({
  specs: [] as AgentRunSpec[],
  resume: 'resent' as 'resent' | 'in-thread',
  listeners: new Set<() => void>(),
}));

// What is under test is the system prompt RunManager composes at both session construction
// sites (`runAgentStep` and `runContinuation`), before the runner seam.
useRunners(fakeRunnerFactory((backend: string) => ({
    backend,
    systemPromptOnResume: launched.resume,
    run: async () => ({ text: '', toolCalls: [], tokensUsed: 0 }),
    startSession: (spec: AgentRunSpec) => {
      launched.specs.push(spec);
      for (const listener of launched.listeners) listener();
      return {
        result: Promise.resolve({ text: 'ok', toolCalls: [], tokensUsed: 0 }),
        sendMessage: () => false,
        discardQueuedMessages: () => {}, holdsHumanInput: () => false,
        end: () => {},
        interrupt: () => {},
        open: false,
      };
    },
    interrupt: async () => {},
  })));
sealTestRunners();

const DIVIDER = '\n\n---\n\n';
const SKILL = { name: 'pin', description: 'Pins the composed system prompt.', body: 'Follow the pinned playbook.' };
const EXTRA = 'Extra system prompt part.';
const DELEGATION = 'Delegation instructions part.';
const WORKFLOW: WorkflowDef = { name: 'pinned', source: 'built-in', steps: [{ id: 'task', skill: SKILL.name, prompt: '{{task}}' }] };

/**
 * hearsay-tools/cezarion#1632: the whole system prompt, byte for byte, at both launch sites, with
 * every system part present: the run's extra prompt, the delegation instructions,
 * automations, project webhooks, the artifact contract and the handoff contract, in that order.
 * The expected text joins the parts directly, so it does not depend on how the sites compose them.
 */
describe('launch system prompt at both sites (#1632)', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager | undefined;
  let projectId: string;

  beforeEach(async () => {
    launched.specs.length = 0;
    launched.resume = 'resent';
    vi.stubEnv('CEZ_AUTOMATIONS', '1');
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-launch-system-prompt-'));
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    await run('git', ['config', 'gc.auto', '0'], { cwd: repoRoot });
    await run('git', ['config', 'maintenance.auto', 'false'], { cwd: repoRoot });
    mkdirSync(join(repoRoot, '.ai/skills', SKILL.name), { recursive: true });
    writeFileSync(join(repoRoot, '.ai/skills', SKILL.name, 'SKILL.md'),
      `---\nname: ${SKILL.name}\ndescription: ${SKILL.description}\n---\n${SKILL.body}\n`, 'utf8');
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    projectId = (await registerProject(repoRoot, undefined, testHome())).id;
    await mergeWriteWorkspaceConfig((config) => {
      config.projects.find((project) => project.id === projectId)!.webhooks = [{
        id: 'friction', name: 'Friction reports', description: 'Friction you hit with tools.', agent: true,
        url: 'https://friction.example/hook', token: 'never-in-a-prompt', tasks: false,
      }];
    }, testHome());
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = createFixtureManager(store, repoRoot, { skillCatalog: fixedSkillCatalog([{
      id: SKILL.name, name: SKILL.name, description: SKILL.description, scope: 'repo',
      path: join(repoRoot, '.ai/skills', SKILL.name, 'SKILL.md'),
    }]) });
    manager.setCockpitAddress({ origin: 'http://127.0.0.1:5555', projectId });
    manager.setDelegationProvisioner(() => ({ env: {}, instructions: DELEGATION, restrictCrossSessionMessaging: true, revoke: () => {} }));
  });

  afterEach(async () => {
    await drainFixtureManagers(repoRoot);
    manager?.dispose();
    manager = undefined;
    store.persistence.flush();
    await mergeWriteWorkspaceConfig((config) => {
      config.projects = config.projects.filter((project) => project.id !== projectId);
    }, testHome());
    rmSync(repoRoot, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  /** Resolves when the runner seam has received spec `index`. */
  function specAt(index: number): Promise<AgentRunSpec> {
    return new Promise((resolve, reject) => {
      const finish = () => { clearTimeout(guard); launched.listeners.delete(check); };
      const check = () => { if (launched.specs.length > index) { finish(); resolve(launched.specs[index]!); } };
      // bound: a hang guard only; the runner seam's call ends the wait. Git fixture setup and
      // provisioning take seconds under load.
      const guard = setTimeout(() => { finish(); reject(new Error(`no launch #${index}`)); }, 15_000);
      launched.listeners.add(check);
      check();
    });
  }

  /** A fresh run, then a Continue of its session: the two launch sites, in that order. */
  async function startAndContinue(): Promise<[AgentRunSpec, AgentRunSpec]> {
    const record = manager!.startRun(WORKFLOW, { task: 'do it', worktree: false, runner: 'claude', systemPrompt: EXTRA });
    const opening = await specAt(0);
    // bound: the runner has returned; wait for public settlement before Continue.
    await vi.waitFor(() => {
      expect(manager!.isActive(record.id)).toBe(false);
      expect(store.getRun(record.id)?.status).toBe('done');
    }, { timeout: 15_000 });
    store.updateStep(record.id, 'task', { sessionId: 'sess-1', backend: 'claude' });
    expect(manager!.continueRun(record.id, { text: 'keep going' })).toEqual({ ok: true });
    const continued = await specAt(1);
    // bound: the continuation's returned result must settle and release its session.
    await vi.waitFor(() => {
      expect(manager!.isActive(record.id)).toBe(false);
      expect(store.getRun(record.id)?.status).toBe('done');
    }, { timeout: 15_000 });
    return [opening, continued];
  }

  /** The system parts, as the spec's own environment and tools make them. */
  async function tail(spec: AgentRunSpec): Promise<string[]> {
    const webhooks = agentWebhooksPrompt(webhookCliCommand(), agentWebhooks(await registryEntry(projectId, repoRoot, testHome())));
    return [
      EXTRA, DELEGATION, automationsPrompt(automationCliCommand()), webhooks!,
      artifactInstructions(spec.env?.CEZ_ARTIFACTS_DIR), jobInstructions(), handoffInstructions({ handoffInjected: true, nativeSubagents: true }),
    ];
  }

  it('a fresh step and a Continue compose every system part in order', async () => {
    const [opening, continued] = await startAndContinue();
    for (const part of await tail(opening)) expect(part.trim()).not.toBe('');
    expect(opening.systemPrompt).toBe((await tail(opening)).join(DIVIDER));
    expect(continued.systemPrompt).toBe((await tail(continued)).join(DIVIDER));
    expect(opening.skill).toMatchObject({ id: SKILL.name, args: 'do it' });
    expect(continued.skill).toBeUndefined();
    expect(continued.resumeFallbackSkill).toMatchObject({ id: SKILL.name, args: '' });
    expect(continued.resumeFallbackSystemPrompt).toBeUndefined();
    expect(opening.systemPrompt).not.toContain(SKILL.body);
  });

  it('an in-thread Continue carries the native trigger only as a fresh-session fallback', async () => {
    launched.resume = 'in-thread';
    const [, continued] = await startAndContinue();
    expect(continued.systemPrompt).toBe((await tail(continued)).join(DIVIDER));
    expect(continued.resumeFallbackSystemPrompt).toBeUndefined();
    expect(continued.skill).toBeUndefined();
    expect(continued.resumeFallbackSkill).toMatchObject({ id: SKILL.name, args: '' });
    expect(continued.userPrompt).toContain('keep going');
  });
});
