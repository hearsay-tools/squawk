import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createActiveRun } from '../active-run.ts';
import type { RunModuleContext } from './types.ts';
import { WorktreeAutosave } from './worktree-autosave.ts';

let root: string, host: string;
const git = (...args: string[]) => execFileSync('git', args, { cwd: host, encoding: 'utf8', stdio: 'pipe' }).trim();
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cez-autosave-shared-')); host = join(root, 'host');
  execFileSync('git', ['init', '-q', '-b', 'main', host]);
  git('config', 'user.name', 'test'); git('config', 'user.email', 'test@local'); git('commit', '--allow-empty', '-qm', 'base');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A manager whose store no longer has the run: every record read throws. */
function autosave(): WorktreeAutosave {
  const gone = () => { throw new Error('the run record is gone'); };
  return new WorktreeAutosave({ repoRoot: join(root, 'repo-root'), dataDir: join(root, 'data'), disposed: () => false,
    store: { getRun: gone, eventLog: { appendEvent: gone } }, work: { track: (_name: string, work: Promise<void>) => work } } as unknown as RunModuleContext,
  { holdForMaintenance: () => null, reapTerminalScratch: () => undefined, releaseSlot: () => undefined, saveWorktree: async () => undefined, trackTurn: () => undefined });
}

it('commits nothing in the host directory for a run that shares it, also when its record cannot be read at finalize (hearsay-tools/squawk#3819)', async () => {
  const head = git('rev-parse', 'HEAD');
  writeFileSync(join(host, 'written-by-worker.txt'), 'x\n');
  const shared = createActiveRun({ cwd: host, pendingHumanAsk: false, autonomous: false });
  shared.liveSession.markSharedDirectory();
  await autosave().saveWorktree('10000000-0000-4000-8000-000000000001', shared, 'run finalize');
  expect(git('rev-parse', 'HEAD')).toBe(head);
  expect(git('status', '--porcelain')).toBe('?? written-by-worker.txt');
  // The same save for a run that owns the directory commits: the mark alone decides.
  const owner = createActiveRun({ cwd: host, pendingHumanAsk: false, autonomous: false });
  await autosave().saveWorktree('10000000-0000-4000-8000-000000000002', owner, 'run finalize');
  expect(git('rev-parse', 'HEAD')).not.toBe(head);
  expect(git('status', '--porcelain')).toBe('');
});
