import { chmod, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { ownedCleanupProtection } from '../git-worktree.ts';
import { ownedWorkspaceReceipts } from './workspace-record.ts';
import { createOwnedWorkspace } from './workspace.ts';
import { fixture, git, receiptPath, WORKSPACE_TEST_TIMEOUT_MS } from './workspace-fixture.testkit.ts';
import { identityFileStore } from './identity-file-store.ts';

// Both consumers must see edits on their next call, including after a successful cache hit.
describe('stat-validated owned receipts', { timeout: WORKSPACE_TEST_TIMEOUT_MS }, () => {
  it('reuses checked reads, isolates returned objects, and detects receipt changes', async () => {
    const { root, first } = await fixture();
    const workspace = await createOwnedWorkspace(root, crypto.randomUUID(), first);
    const path = receiptPath(root, workspace);
    const original = await readFile(path, 'utf8');
    git(root, 'worktree', 'remove', workspace.path);
    const read = vi.spyOn(identityFileStore(), 'read');
    expect(await ownedWorkspaceReceipts(root)).toEqual([{ workspace, cleaned: false }]);
    read.mockClear();
    const warm = await ownedWorkspaceReceipts(root);
    expect(read).not.toHaveBeenCalled();
    warm[0]!.workspace.path = '/caller-mutation';
    expect((await ownedWorkspaceReceipts(root))[0]!.workspace).toEqual(workspace);
    expect((await ownedCleanupProtection(root)).paths.has(workspace.path)).toBe(true);
    const changed = JSON.parse(original);
    changed.workspace.baselineSha = 'b'.repeat(40);
    await writeFile(path, JSON.stringify(changed));
    expect((await ownedWorkspaceReceipts(root))[0]!.workspace.baselineSha).toBe('b'.repeat(40));
    await writeFile(path, '{}');
    expect(await ownedWorkspaceReceipts(root)).toEqual([]);
    expect((await ownedCleanupProtection(root)).uncertain).toBe(true);
    await writeFile(path, original);
    expect(await ownedWorkspaceReceipts(root)).toEqual([{ workspace, cleaned: false }]);
    expect((await ownedCleanupProtection(root)).uncertain).toBe(false);
    await chmod(path, 0o644);
    expect(await ownedWorkspaceReceipts(root)).toEqual([]);
    await chmod(path, 0o600);
    await rename(path, `${path}.saved`);
    await symlink(`${path}.saved`, path);
    expect(await ownedWorkspaceReceipts(root)).toEqual([]);
    expect((await ownedCleanupProtection(root)).uncertain).toBe(true);
    await rm(path);
    expect(await ownedWorkspaceReceipts(root)).toEqual([]);
    expect((await ownedCleanupProtection(root)).paths.has(workspace.path)).toBe(false);
    await rename(`${path}.saved`, path);
    expect(await ownedWorkspaceReceipts(root)).toEqual([{ workspace, cleaned: false }]);
  });

  it('invalidates created, modified, symlinked and removed cleanup checkpoints', async () => {
    const { root, first } = await fixture();
    const workspace = await createOwnedWorkspace(root, crypto.randomUUID(), first);
    const path = receiptPath(root, workspace).replace(/\.json$/, '.cleanup.json');
    expect(await ownedWorkspaceReceipts(root)).toEqual([{ workspace, cleaned: false }]);
    const checkpoint = { workspace, gitDir: root, sha: first,
      logFile: { dev: 1, ino: 1, birthtimeMs: 1 }, logHash: 'a'.repeat(64), phase: 'prepared' };
    await writeFile(path, JSON.stringify(checkpoint), { mode: 0o600 });
    expect(await ownedWorkspaceReceipts(root)).toEqual([{ workspace, cleaned: false }]);
    await writeFile(path, JSON.stringify({ ...checkpoint, phase: 'complete' }));
    expect(await ownedWorkspaceReceipts(root)).toEqual([{ workspace, cleaned: true }]);
    expect(await ownedWorkspaceReceipts(root)).toEqual([{ workspace, cleaned: true }]);
    await rename(path, `${path}.saved`);
    await symlink(`${path}.saved`, path);
    expect(await ownedWorkspaceReceipts(root)).toEqual([]);
    expect((await ownedCleanupProtection(root)).uncertain).toBe(true);
    await rm(path);
    expect(await ownedWorkspaceReceipts(root)).toEqual([{ workspace, cleaned: false }]);
  });
});
