import '../runners/claude/claude-runner.testkit.ts';
import { GIT_ID, waitForProduct } from './run-fixture.testkit.ts';
import { shellQuote } from '../core/shell-env.ts';
import { createFixtureManager, drainFixtureManagers } from './fixture-claude.testkit.ts';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { WorkflowDef } from './types.ts';

vi.mock('../git-worktree.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../git-worktree.ts')>();
  return {
    ...actual,
    createWorktree: vi.fn().mockRejectedValue(new Error('simulated worktree failure')),
  };
});



// These fixtures exercise checks and Git, never the auxiliary LLM namer.
beforeEach(() => vi.stubEnv('CEZ_AUTONAME', '0'));
afterEach(() => vi.unstubAllEnvs());

const roots: string[] = [];

function fixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'cez-root-isolation-'));
  roots.push(root);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', ['config', 'gc.auto', '0'], { cwd: root });
  execFileSync('git', ['config', 'maintenance.auto', 'false'], { cwd: root });
  execFileSync('git', [...GIT_ID, 'commit', '--allow-empty', '-q', '-m', 'base'], { cwd: root });
  return root;
}

afterEach(async () => {
  for (const root of roots) await drainFixtureManagers(root);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('RunManager repository-root isolation', () => {
  it('fails closed without executing a workflow step when worktree creation fails', async () => {
    const root = fixtureRepo();
    const store = RunStore.open(join(root, '.ai/cezar'));
    const manager = createFixtureManager(store, root);
    const workflow: WorkflowDef = {
      name: 'must-not-run-in-root',
      source: 'built-in',
      steps: [{ id: 'check', command: 'node -e "require(\'node:fs\').writeFileSync(\'root-was-touched\',\'yes\')"' }],
    };

    const record = manager.startRun(workflow, { task: 'isolated task' });
    // bound: store and owned work signals settle the failed start; 15 seconds only detects a hang.
    await waitForProduct(manager, store, () => ['done', 'failed', 'cancelled'].includes(store.getRun(record.id)?.status ?? ''));

    expect(store.getRun(record.id)?.status).toBe('failed');
    expect(store.getRun(record.id)?.error).toContain('worktree creation failed');
    expect(existsSync(join(root, 'root-was-touched'))).toBe(false);
    const notes = store.readEvents(record.id).filter((event) => event.type === 'note');
    expect(notes.some((event) => String(event.message).includes('worktree on'))).toBe(true);
    expect(notes.some((event) => String(event.message).includes('(default)'))).toBe(true);
    expect(notes.some((event) => String(event.message).includes('stopped before workflow execution'))).toBe(true);
    expect(notes.some((event) => String(event.message).includes('exclusive access'))).toBe(false);
  });

  it('allows explicitly unsafe root runs to overlap when the repository lock is disabled', async () => {
    const previous = process.env.CEZ_DISABLE_REPO_LOCK;
    process.env.CEZ_DISABLE_REPO_LOCK = '1';
    try {
      const root = fixtureRepo();
      const store = RunStore.open(join(root, '.ai/cezar'));
      const manager = createFixtureManager(store, root);
      const gate = join(root, '.ai/cezar', 'unsafe-release');
      // bound: release the check processes on a failed assertion instead of holding them forever.
      const hold = 'const fs=require("node:fs"); const end=Date.now()+20000; '
        + 'const poll=()=>{if(fs.existsSync(process.argv[1]))return; '
        + 'if(Date.now()>end)process.exit(42); setTimeout(poll,10)}; poll();';
      const workflow: WorkflowDef = {
        name: 'root-lock-bypass-check',
        source: 'built-in',
        steps: [{ id: 'hold', command: `node -e ${shellQuote(hold)} ${shellQuote(gate)}` }],
      };

      const first = manager.startRun(workflow, { task: 'first', worktree: false });
      const second = manager.startRun(workflow, { task: 'second', worktree: false });

      try {
        // bound: step-start is the product signal; 15 seconds only detects a blocked second run.
        await waitForProduct(manager, store, () => [first.id, second.id].every(id =>
          store.readEvents(id).some(event => event.type === 'step-start')));
        expect(store.getRun(first.id)?.status).toBe('running');
        expect(store.getRun(second.id)?.status).toBe('running');
      } finally {
        writeFileSync(gate, '');
      }
      // bound: completion follows the release file; 15 seconds only detects a failed settlement.
      await waitForProduct(manager, store, () => [first.id, second.id].every(id =>
        ['done', 'failed', 'cancelled'].includes(store.getRun(id)?.status ?? '')));

      expect(store.getRun(first.id)?.status).toBe('done');
      expect(store.getRun(second.id)?.status).toBe('done');
      for (const id of [first.id, second.id]) {
        const notes = store.readEvents(id).filter((event) => event.type === 'note');
        expect(notes.some((event) => String(event.message).includes('repository-root lock disabled'))).toBe(true);
        expect(notes.some((event) => String(event.message).includes('exclusive access'))).toBe(false);
      }
    } finally {
      if (previous === undefined) delete process.env.CEZ_DISABLE_REPO_LOCK;
      else process.env.CEZ_DISABLE_REPO_LOCK = previous;
    }
  // bound: two real Git/check processes may use the per-transition 15-second hang guards.
  }, 30_000);
});
