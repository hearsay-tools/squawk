import { sealTestRunners } from './runner-registry.testkit.ts';
import { setRunStatus } from '../runs/run-store.testkit.ts';
import { RUN_STATUS, STEP_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { randomUUID } from 'node:crypto';
import { gitSync } from '../git-command.ts';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerSpawnRequest } from '@open-mercato/cezar-contract';
import type { AgentRunResult, AgentRunSpec, AgentSession } from './agent-runner.ts';
import * as runners from './runner-registry.ts';
import { CLAUDE_SPEC_SUPPORT } from '../runners/claude/spec-support.ts';
import './created-runners.testkit.ts';
import { fixture } from '../delegation/service-engine.testkit.ts';
import { claudeRunner } from '../runners/claude/definition.ts';

sealTestRunners(claudeRunner);

const until = (predicate: () => boolean) => vi.waitFor(() => expect(predicate()).toBe(true), { timeout: 15_000, interval: 10 });
const ATTACHED = { 'qa/1149/brief.md': 'the brief\n', 'qa/evidence.log': 'evidence bytes\n' } as const;

// Real acceptance, store, manager and worktree, which the first agent turn needs; only the agent wire is
// fake, and it records what the worker's worktree holds at the moment its session starts
// (hearsay-tools/cezarion#1149).
describe('attached parent files in the worker worktree', { timeout: 30_000 }, () => {
  let f: ReturnType<typeof fixture>;
  const tools = new Map<string, ReturnType<typeof f.manager.squawkToolHandlers>>();
  const seen: Array<{ spec: AgentRunSpec; files: Record<string, string | undefined>; claudeLocal?: string | undefined; finish(): void; done(runId: string): Promise<void> }> = [];
  const spawn = (paths: readonly string[]) => f.service.spawn(f.caller, { task: 'inspect', baseline: 'parent-head', requestId: randomUUID(),
    context: { artifacts: paths.map(path => ({ kind: 'parent-file' as const, path })) } satisfies WorkerSpawnRequest['context'] });
  const commit = (path: string, content: string) => {
    mkdirSync(dirname(join(f.root, path)), { recursive: true }); writeFileSync(join(f.root, path), content);
    gitSync(['add', path], { cwd: f.root });
    gitSync(['-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '-qm', path], { cwd: f.root });
  };
  const write = (path: string, content: string) => {
    mkdirSync(dirname(join(f.root, path)), { recursive: true }); writeFileSync(join(f.root, path), content);
  };
  const workerOf = (workerId: string) => {
    const worker = f.store.getRun(workerId)!;
    if (worker.delegation?.role !== 'worker') throw Error('worker');
    return { worker, delegation: worker.delegation };
  };
  const launch = async () => {
    await f.releaseAdmission();
  };
  beforeEach(() => {
    vi.stubEnv('CEZ_DRY_RUN', '1'); vi.stubEnv('CEZ_AUTONAME', '0');
    f = fixture();
    tools.clear();
    const handlers = f.manager.squawkToolHandlers.bind(f.manager);
    vi.spyOn(f.manager, 'squawkToolHandlers').mockImplementation((id, generation) => {
      const launched = handlers(id, generation);
      tools.set(id, launched);
      return launched;
    });
    vi.spyOn(runners, 'createRunner').mockImplementation(async backend => ({ backend: backend ?? 'claude', specSupport: CLAUDE_SPEC_SUPPORT, systemPromptOnResume: 'resent',
      interrupt: async () => {}, run: async () => ({ text: '', toolCalls: [], tokensUsed: 0 }), startSession: (spec, onEvent) => {
        const read = (path: string) => existsSync(join(spec.cwd, path)) ? readFileSync(join(spec.cwd, path), 'utf8') : undefined;
        const files = Object.fromEntries(Object.keys(ATTACHED).map(path => [path, read(path)]));
        const claudeLocal = read('CLAUDE.local.md');
        let resolve!: (value: AgentRunResult) => void; let open = true;
        const result = new Promise<AgentRunResult>(done => { resolve = done; });
        const finish = () => { if (open) { open = false; resolve({ text: '', toolCalls: [], tokensUsed: 0 }); } };
        const session: AgentSession = { result, get open() { return open; }, sendMessage: () => open, sendAgentMessage: () => open ? Promise.resolve() : false,
          discardQueuedMessages: () => {}, holdsHumanInput: () => false, interrupt: finish, end: finish };
        // An earlier workflow step completes only on an accepted cezar_done (hearsay-tools/cezarion#1620).
        const done = async (runId: string) => {
          if (open) {
            const answer = await tools.get(runId)!.finishTurn({}, new AbortController().signal);
            if (!answer.ok) throw new Error(`cezar_done refused: ${answer.code}`);
            onEvent?.({ type: 'text', text: 'ok' }); onEvent?.({ type: 'turn-end' });
          }
          finish();
        };
        seen.push({ spec, files, claudeLocal, finish, done }); return session;
      } }));
  });
  afterEach(async () => {
    for (const s of seen) s.finish();
    seen.length = 0;
    await f.close(); vi.restoreAllMocks(); vi.unstubAllEnvs();
  });

  it('attached ignored files exist in the worktree when the first agent turn starts', async () => {
    commit('.gitignore', 'qa/\n');
    for (const [path, content] of Object.entries(ATTACHED)) write(path, content);
    const { workerId } = await spawn(Object.keys(ATTACHED));
    await launch();
    await until(() => seen.length === 1);
    const { delegation } = workerOf(workerId);
    expect(seen[0]!.spec.cwd).toBe(delegation.workspace.path);
    expect(seen[0]!.files).toEqual(ATTACHED);
  });

  it('an attached personal config file is not overwritten by the main checkout\'s copy before the first turn', async () => {
    // The parent works in its own worktree; automatic config seeding copies from the main checkout.
    commit('.gitignore', 'CLAUDE.local.md\n');
    const parentCwd = mkdtempSync(join(tmpdir(), 'cez-attach-parent-'));
    rmdirSync(parentCwd);
    gitSync(['worktree', 'add', '-q', '--detach', parentCwd, 'HEAD'], { cwd: f.root });
    try {
      f.store.updateRun(f.parent.id, { worktreePath: parentCwd });
      const settings = f.manager.delegationExecutionSettings(f.parent.id);
      vi.mocked(f.manager.delegationExecutionSettings).mockReturnValue({ ...settings, cwd: parentCwd });
      write('CLAUDE.local.md', 'main checkout bytes');
      writeFileSync(join(parentCwd, 'CLAUDE.local.md'), 'explicit parent attachment');
      await spawn(['CLAUDE.local.md']);
      await launch();
      await until(() => seen.length === 1);
      expect(seen[0]!.claudeLocal).toBe('explicit parent attachment');
    } finally { rmSync(parentCwd, { recursive: true, force: true }); }
  });

  it('Continue does not restore an attached file the worker deleted', async () => {
    commit('.gitignore', 'qa/\n');
    for (const [path, content] of Object.entries(ATTACHED)) write(path, content);
    const { workerId } = await spawn(Object.keys(ATTACHED));
    await launch();
    await until(() => seen.length === 1);
    expect(seen[0]!.files['qa/1149/brief.md']).toBe(ATTACHED['qa/1149/brief.md']);
    rmSync(join(seen[0]!.spec.cwd, 'qa/1149/brief.md'));
    seen[0]!.finish();
    expect(await f.manager.awaitRunTermination(workerId, 15_000)).toBe(true);
    expect(f.manager.continueRun(workerId, { text: 'continue' }).ok).toBe(true);
    await until(() => seen.length === 2);
    expect(seen[1]!.files).toEqual({ 'qa/1149/brief.md': undefined, 'qa/evidence.log': ATTACHED['qa/evidence.log'] });
    expect(f.store.getRun(workerId)?.status).not.toBe('failed');
  });

  it('a worker re-queued past its first step does not get a deleted attachment back', async () => {
    commit('.gitignore', 'qa/\n');
    for (const [path, content] of Object.entries(ATTACHED)) write(path, content);
    const dir = join(f.root, '.ai/cezar/workflows'); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'two-step.yaml'), ['name: two-step', 'steps:', '  - id: first', '    prompt: "{{task}}"', '  - id: second', '    prompt: "again"'].join('\n'));
    const { workerId } = await f.service.spawn(f.caller, { task: 'inspect', baseline: 'parent-head', requestId: randomUUID(), workflow: 'two-step',
      context: { artifacts: Object.keys(ATTACHED).map(path => ({ kind: 'parent-file' as const, path })) } });
    await launch();
    await until(() => seen.length === 1);
    rmSync(join(seen[0]!.spec.cwd, 'qa/1149/brief.md'));
    await seen[0]!.done(workerId);
    await until(() => seen.length === 2);
    seen[1]!.finish();
    expect(await f.manager.awaitRunTermination(workerId, 15_000)).toBe(true);
    // The durable shape a restart re-queues: the first step done, the second still pending.
    f.store.updateStep(workerId, 'second', { status: STEP_STATUS.pending, finishedAt: undefined });
    setRunStatus(f.store, workerId, RUN_STATUS.queued, { finishedAt: undefined, error: undefined });
    // Recovery must see a parked parent, rather than fail an interrupted synthetic parent.
    setRunStatus(f.store, f.parent.id, RUN_STATUS.waiting);
    await f.manager.recover();
    await until(() => seen.length === 3);
    expect(seen[2]!.files).toEqual({ 'qa/1149/brief.md': undefined, 'qa/evidence.log': ATTACHED['qa/evidence.log'] });
  });
});
