import { sealTestRunners } from '../core/runner-registry.testkit.ts';
import { request } from 'node:http';
import { json } from 'node:stream/consumers';
import { seedOldSkills } from '../worktree-skill-cleanup.testkit.ts';
import { removeProvisionedSkills } from '../worktree-skill-cleanup.ts';
import { readManifest } from '../worktree-manifest.testkit.ts';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRunResult, AgentRunSpec } from '../core/agent-runner.ts';
import { CLAUDE_SPEC_SUPPORT } from '../runners/claude/spec-support.ts';
import { fixedSkillCatalog } from '../core/runner-skill-fixture.testkit.ts';
import * as runners from '../core/runner-registry.ts';
import { RunStore } from '../runs/store.ts';
import '../core/created-runners.testkit.ts';
import { createFixtureManager, drainFixtureManagers } from './fixture-manager.testkit.ts';
import type { RunManager } from './run.ts';
import { plannedWorkflow, skillTaskSteps, type WorkflowDef } from './types.ts';
import { claudeRunner } from '../runners/claude/definition.ts';

sealTestRunners(claudeRunner);

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
const BODY = 'OLD-SQUAWK-ONLY-PLAYBOOK';
const NATIVE = 'native-playbook';
const LEGACY = 'squawk-only-playbook';
const SINGLE_STEP: WorkflowDef = plannedWorkflow([{ id: 'task', prompt: '{{task}}' }]);

/** Native skill selection does not stage Squawk's catalog, its companions or its bodies. */
describe('native skills do not materialize Squawk copies', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  let launches: AgentRunSpec[];
  let finish: (() => void)[];
  let turnEnd: (() => void)[];

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-native-no-copy-'));
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    await run('git', ['config', 'gc.auto', '0'], { cwd: repoRoot });
    await run('git', ['config', 'maintenance.auto', 'false'], { cwd: repoRoot });
    mkdirSync(join(repoRoot, '.ai/cezar/skills'), { recursive: true });
    writeFileSync(join(repoRoot, '.ai/cezar/skills', `${LEGACY}.md`), BODY);
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = createFixtureManager(store, repoRoot, { skillCatalog: fixedSkillCatalog([{
      id: NATIVE, name: NATIVE, scope: 'user', path: join(repoRoot, 'account-skills', NATIVE, 'SKILL.md'),
    }]) });
    launches = []; finish = []; turnEnd = [];
    vi.spyOn(runners, 'createRunner').mockImplementation(async backend => ({
      backend: backend ?? 'claude', specSupport: CLAUDE_SPEC_SUPPORT, systemPromptOnResume: 'resent',
      run: async () => ({ text: '', toolCalls: [], tokensUsed: 0 }), interrupt: async () => {},
      startSession: (spec, onEvent) => {
        turnEnd.push(() => onEvent?.({ type: 'turn-end' }));
        launches.push(spec);
        let end!: () => void;
        let open = true;
        const result = new Promise<AgentRunResult>(resolve => { end = () => { open = false; resolve({ text: 'ok', toolCalls: [], tokensUsed: 0 }); }; });
        finish.push(end);
        return { result, get open() { return open; }, sendMessage: () => open,
          sendAgentMessage: () => false, discardQueuedMessages: () => {}, holdsHumanInput: () => false,
          interrupt: end, end };
      },
    }));
  });

  afterEach(async () => {
    for (const end of finish) end();
    await drainFixtureManagers(repoRoot);
    store.persistence.flush();
    vi.restoreAllMocks();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  async function launch(task: string, worktree: boolean, skill?: string): Promise<AgentRunSpec> {
    manager.startRun(skill ? plannedWorkflow(skillTaskSteps(skill)) : SINGLE_STEP, { task, worktree, runner: 'claude' });
    // bound: startSession is the observed launch signal; git workspace setup may take seconds.
    await vi.waitFor(() => expect(launches).toHaveLength(1), { timeout: 15_000 });
    return launches[0]!;
  }

  function noCopies(cwd: string): void {
    for (const directory of ['.agents', '.claude']) expect(existsSync(join(cwd, directory, 'skills'))).toBe(false);
  }

  it.each([true, false])('selected native skill carries no body and writes no copies (worktree=%s)', async worktree => {
    const spec = await launch('do the work', worktree, NATIVE);
    expect(spec.skill).toMatchObject({ id: NATIVE, args: 'do the work' });
    expect(spec.systemPrompt).not.toContain(BODY);
    expect(spec.systemPrompt).not.toContain('Selected skill:');
    noCopies(spec.cwd); noCopies(repoRoot);
  });

  it('a known leading name starts natively without expanding its body', async () => {
    const spec = await launch(`/${NATIVE} inspect the diff`, false);
    expect(spec.skill).toMatchObject({ id: NATIVE, args: 'inspect the diff' });
    expect(spec.userPrompt).not.toContain(BODY);
    noCopies(spec.cwd);
  });

  it.each([`/${LEGACY} inspect`, `Fix it, then run /${LEGACY}.`, '/compact now'])('passes text through without installing Squawk catalog entries: %s', async task => {
    const spec = await launch(task, false);
    expect(spec.skill).toBeUndefined();
    expect(spec.userPrompt).toContain(task);
    expect(spec.userPrompt).not.toContain(BODY);
    noCopies(spec.cwd);
  });

  it('a selected Squawk-only entry fails before a native session starts', async () => {
    const record = manager.startRun(plannedWorkflow(skillTaskSteps(LEGACY)), { task: 'go', worktree: false, runner: 'claude' });
    // bound: the step's failed state is the resolver's completion signal.
    await vi.waitFor(() => expect(store.getRun(record.id)?.status).toBe('failed'), { timeout: 15_000 });
    expect(launches).toEqual([]);
    expect(store.getRun(record.id)?.error).toContain(LEGACY);
    expect(store.getRun(record.id)?.error).toContain('claude');
    expect(store.getRun(record.id)?.error).toContain('default');
    noCopies(repoRoot);
  });

  it.each(['unchanged', 'changed', 'interrupted'] as const)('cleans old recorded skills at next step open (%s)', async kind => {
    const workflow = plannedWorkflow([{ id: 'first', prompt: '{{task}}' }, { id: 'next', prompt: '{{task}}' }]);
    const record = manager.startRun(workflow, { task: 'go', worktree: true, runner: 'claude' });
    // bound: the real worktree must reach the first runner before an old-version manifest is seeded.
    await vi.waitFor(() => expect(launches).toHaveLength(1), { timeout: 15_000 });
    const cwd = launches[0]!.cwd;
    const { paths, manifest } = await seedOldSkills(cwd);
    if (kind === 'changed') writeFileSync(join(cwd, paths[0]!, 'SKILL.md'), 'user edit\n');
    if (kind === 'interrupted') {
      const before = readFileSync(manifest, 'utf8');
      await removeProvisionedSkills(cwd, { faults: boundary => { if (boundary === 'removed') throw new Error('crash between removals'); } });
      expect(readFileSync(manifest, 'utf8')).toBe(before);
      expect(existsSync(join(cwd, paths[0]!))).toBe(false);
      expect(existsSync(join(cwd, paths[1]!))).toBe(true);
      expect(existsSync(join(cwd, paths[1]!, '../.gitignore'))).toBe(true);
      expect((await run('git', ['check-ignore', `${paths[1]}/SKILL.md`], { cwd })).stdout.trim()).toBe(`${paths[1]}/SKILL.md`);
    }
    const catalog = fixedSkillCatalog();
    const get = catalog.get.bind(catalog);
    vi.spyOn(catalog, 'get').mockImplementation(query => {
      expect(existsSync(join(cwd, paths[1]!))).toBe(false);
      return get(query);
    });
    manager.setSkillCatalog(catalog);
    // Closing a provider session is not step completion. Use the agent's done boundary.
    const spec = launches[0]!;
    const response = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
      const call = request({ socketPath: spec.env!.CEZ_TOOL_SOCKET, path: '/api/v1/tools/done', method: 'POST',
        headers: { authorization: `Bearer ${spec.env!.CEZ_TOOL_TOKEN}`, 'content-type': 'application/json' } }, resolve);
      call.on('error', reject);
      call.end('{}');
    });
    expect(await json(response)).toMatchObject({ ok: true });
    turnEnd[0]!();
    // bound: the workflow's second startSession is the cleanup completion signal.
    await vi.waitFor(() => expect(launches).toHaveLength(2), { timeout: 15_000 });
    expect(store.getRun(record.id)?.error).toBeUndefined();
    for (const path of paths) {
      expect(existsSync(join(cwd, path))).toBe(kind === 'changed' && path === paths[0]);
      expect(existsSync(join(cwd, path, '../.gitignore'))).toBe(false);
    }
    if (kind === 'changed') {
      expect(readFileSync(join(cwd, paths[0]!, 'SKILL.md'), 'utf8')).toBe('user edit\n');
      expect((await run('git', ['check-ignore', `${paths[0]}/SKILL.md`], { cwd })).stdout.trim()).toBe(`${paths[0]}/SKILL.md`);
    }
    expect((await readManifest(cwd))?.entries.some(entry => entry.writer === 'skills') ?? false).toBe(false);
  });

  it('cleans old recorded skills at Continue before starting the runner', async () => {
    const record = manager.startRun(SINGLE_STEP, { task: 'go', worktree: true, runner: 'claude' });
    // bound: startSession publishes the worktree that the old installer would have written into.
    await vi.waitFor(() => expect(launches).toHaveLength(1), { timeout: 15_000 });
    const cwd = launches[0]!.cwd;
    finish[0]!();
    // bound: Continue must observe the completed initial run, rather than steering its live session.
    await vi.waitFor(() => expect(manager.isActive(record.id)).toBe(false), { timeout: 15_000 });
    const { paths } = await seedOldSkills(cwd);
    const catalog = fixedSkillCatalog();
    const get = catalog.get.bind(catalog);
    vi.spyOn(catalog, 'get').mockImplementation(query => {
      expect(paths.some(path => existsSync(join(cwd, path)))).toBe(false);
      return get(query);
    });
    manager.setSkillCatalog(catalog);
    expect(manager.continueRun(record.id, { text: 'continue' })).toEqual({ ok: true });
    // bound: the continued session is the product signal that prelaunch cleanup completed.
    await vi.waitFor(() => expect(launches).toHaveLength(2), { timeout: 15_000 });
    for (const path of paths) {
      expect(existsSync(join(cwd, path))).toBe(false);
      expect(existsSync(join(cwd, path, '../.gitignore'))).toBe(false);
    }
    expect((await readManifest(cwd))?.entries.some(entry => entry.writer === 'skills') ?? false).toBe(false);
  });

});
