import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerRunner } from '../core/runner-registry.ts';
import { claudeRunner } from '../runners/claude/definition.ts';
import { codexRunner } from '../runners/codex/definition.ts';
import { RunStore } from '../runs/store.ts';

// The accepted identity binds a codex and a claude account; its schema reads each one's account layout from the registry.
registerRunner(claudeRunner);
registerRunner(codexRunner);

/**
 * Worker sidecar files that Squawk wrote before the worker-executions code left `runs/store.ts`
 * (hearsay-tools/squawk#4039) still read. `fixtures/worker-sidecars/` holds the four private files of
 * one worker, written by the store at main 3a64a4e25 through its own writers. Git keeps no 0600
 * mode, so each case copies them into a fresh data directory with that mode first.
 */
const FIXTURES = join(import.meta.dirname, 'fixtures', 'worker-sidecars');
const ID = '7d0b1c4e-5a3f-4e2b-9c61-2f8a0d9e4b17';
const GENERATION = '3c9e5b71-0d24-4f6a-8e13-6b2f7a9c0d58';
const codex = { provider: 'codex', profileId: 'work', homePath: '/home/worker/codex-work' };
const claude = { provider: 'claude', profileId: 'default', homePath: '/home/worker/.claude', claudeLayout: { kind: 'relocated' } };
const scope = { workerId: ID, cgroups: [`/sys/fs/cgroup/user.slice/squawk-worker-${ID}`],
  groups: [{ pid: 4243, startToken: 'linux:123460', pgid: 4243 }], jobs: [`Local\\squawk-worker-${ID}`] };

describe('saved worker sidecar files', () => {
  let dataDir: string;
  let store: RunStore;
  const sidecar = (kind: string) => join(dataDir, 'runs', `${ID}.${kind}.json`);

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'worker-sidecars-'));
    mkdirSync(join(dataDir, 'runs'));
    for (const name of readdirSync(FIXTURES)) {
      copyFileSync(join(FIXTURES, name), join(dataDir, 'runs', name));
      chmodSync(join(dataDir, 'runs', name), 0o600);
    }
    store = RunStore.open(dataDir);
  });
  afterEach(() => {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('reads the identity, execution, process and scope records an earlier Squawk wrote', () => {
    expect(store.readWorkerIdentity(ID)).toEqual({ kind: 'accepted', account: codex, grants: {}, model: 'gpt-5.1-codex', effort: 'high',
      contextHash: 'a'.repeat(64), workflowHash: 'b'.repeat(64), steps: [
        { stepId: 'implement', account: codex, grants: {}, model: 'gpt-5.1-codex', effort: 'high' },
        { stepId: 'review', account: claude, grants: { allowedTools: ['Read'], bashAllowlist: ['git diff'] }, model: 'opus' },
      ] });
    expect(store.readWorkerExecution(ID)).toEqual({ generation: GENERATION, phase: 'complete', interrupted: true,
      scratchCleanup: { resourceId: '9a4f2e6c-1b73-4d58-a0e9-5c3d8b7f1e26', path: `/home/worker/project/.ai/squawk/worktrees/${ID}` } });
    expect(store.readWorkerProcesses(ID, GENERATION)).toEqual({ generation: GENERATION, controller: { pid: 4242, startToken: 'linux:123456' },
      processes: [{ pid: 4243, startToken: 'linux:123460', pgid: 4243 }, { pid: 4250, startToken: 'linux:123470' }] });
    expect(store.readWorkerScope(ID)).toEqual(scope);
  });

  it('reads a process record of another generation as unknown, and a missing one as absent', () => {
    expect(store.readWorkerProcesses(ID, '00000000-0000-4000-8000-000000000000')).toBe('unknown');
    rmSync(sidecar('processes'));
    rmSync(sidecar('scope'));
    expect(store.readWorkerProcesses(ID, GENERATION)).toBe('absent');
    expect(store.readWorkerScope(ID)).toBe('absent');
  });

  it('refuses a record that others may read', () => {
    for (const kind of ['identity', 'execution', 'processes', 'scope']) chmodSync(sidecar(kind), 0o644);
    expect(store.readWorkerIdentity(ID)).toBeUndefined();
    expect(store.readWorkerExecution(ID)).toBeUndefined();
    expect(store.readWorkerProcesses(ID, GENERATION)).toBe('unknown');
    expect(store.readWorkerScope(ID)).toBe('unknown');
  });

  it('refuses a record that is a symbolic link', () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'worker-sidecars-target-'));
    try {
      for (const kind of ['identity', 'execution', 'processes', 'scope']) {
        const target = join(elsewhere, `${kind}.json`);
        copyFileSync(sidecar(kind), target);
        chmodSync(target, 0o600);
        rmSync(sidecar(kind));
        symlinkSync(target, sidecar(kind));
      }
      expect(store.readWorkerIdentity(ID)).toBeUndefined();
      expect(store.readWorkerExecution(ID)).toBeUndefined();
      expect(store.readWorkerProcesses(ID, GENERATION)).toBe('unknown');
      expect(store.readWorkerScope(ID)).toBe('unknown');
    } finally { rmSync(elsewhere, { recursive: true, force: true }); }
  });

  it('writes a scope record with the same bytes', () => {
    rmSync(sidecar('scope'));
    store.writeWorkerScope(ID, scope);
    expect(readFileSync(sidecar('scope'), 'utf8')).toBe(readFileSync(join(FIXTURES, `${ID}.scope.json`), 'utf8'));
  });
});
