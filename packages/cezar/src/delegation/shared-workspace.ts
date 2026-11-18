/** The shared workspace kind's own functions: a worker that works in its host run's directory.
 *  Everything about that directory comes from the workspace record; nothing here creates,
 *  changes or removes it. */
import { createHash, randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { SHARED_ATTACH_REFUSAL, delegationStateSchema, sharedWorkspaceSchema } from '@open-mercato/cezar-contract/delegation';
import type { SharedWorkerWorkspace, WorkerInput, WorkerInputRecipe } from '@open-mercato/cezar-contract';
import { spawnGit } from '../git-command.ts';
import type { RunRecord } from '../runs/store.ts';
import { baselineBlob, baselineFileHash, canonicalFile, invalidContext, parentFileSnapshotPath, readBoundedContextFile,
  refuseContext, verifyWorkerContext, writeWorkerDataFile, type WorkspaceContextSources } from './context.ts';
import { checkedGit, gitCommonDir } from './workspace-git.ts';

export const SHARED_NO_DIFF = 'a shared workspace has no diff of its own: the worker works in its parent\'s worktree; read the result\'s `changes`';

/** No resource side effects: the record names the host's directory as it is now. */
export async function planSharedWorkspace(request: { workerId: string; hostRunId: string; hostDirectory: string; baselineSha: string }): Promise<SharedWorkerWorkspace> {
  return sharedWorkspaceSchema.parse({
    ownerRunId: request.workerId, resourceId: randomUUID(), kind: 'shared',
    path: await realpath(request.hostDirectory), hostRunId: request.hostRunId, baselineSha: request.baselineSha,
  });
}

function sharedWorkspace(run: RunRecord): SharedWorkerWorkspace {
  const delegation = delegationStateSchema.parse(run.delegation);
  if (delegation.role !== 'worker' || delegation.workspace.ownerRunId !== run.id) throw new Error('Missing worker ownership');
  return sharedWorkspaceSchema.parse(delegation.workspace);
}

/** The recorded directory still exists and is a worktree of this repository. Never creates it. */
export async function verifySharedWorkspace(repoRoot: string, run: RunRecord): Promise<SharedWorkerWorkspace> {
  const workspace = sharedWorkspace(run);
  const gone = () => new Error(`the shared directory ${workspace.path} is gone or is no longer a directory`);
  if (await realpath(workspace.path).catch(() => { throw gone(); }) !== workspace.path) throw new Error(`the shared directory ${workspace.path} is redirected`);
  if (!(await stat(workspace.path).catch(() => { throw gone(); })).isDirectory()) throw gone();
  const foreign = () => new Error(`the shared directory ${workspace.path} is no longer a worktree of this repository`);
  const [common, own, top] = await Promise.all([gitCommonDir(repoRoot), gitCommonDir(workspace.path),
    checkedGit(workspace.path, ['rev-parse', '--show-toplevel']).then(realpath)]).catch(() => { throw foreign(); });
  if (common !== own || top !== workspace.path) throw foreign();
  return workspace;
}

export async function readSharedHead(repoRoot: string, run: RunRecord): Promise<string> {
  const workspace = await verifySharedWorkspace(repoRoot, run);
  return checkedGit(workspace.path, ['rev-parse', '--verify', 'HEAD^{commit}']);
}

/** A blob's bytes, at most `limit`. Not through `runGit`: a blob is not always text. */
function blobBytes(repoRoot: string, blobId: string, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawnGit(['cat-file', 'blob', blobId], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'ignore'], timeout: 30_000 });
    const chunks: Buffer[] = [];
    let size = 0;
    child.stdout?.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) child.kill(); else chunks.push(chunk);
    });
    child.on('error', reject);
    child.on('close', code => { if (code === 0 && size <= limit) resolve(Buffer.concat(chunks)); else reject(invalidContext()); });
  });
}

/** The Git blob id of `bytes`, in the object format the baseline commit id has. */
function blobIdOf(bytes: Buffer, baselineSha: string): string {
  return createHash(baselineSha.length === 64 ? 'sha256' : 'sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

/** Nothing is written into the host's directory: a baseline file is copied from its blob to the
 *  worker's data directory, and a file of the host's worktree is already where the worker runs. */
export const sharedContextSources: WorkspaceContextSources = {
  async baselineFile({ options: { repoRoot, workspace }, source, snapshot, remaining }) {
    const blob = await baselineBlob(repoRoot, workspace.baselineSha, source.path);
    const copy = await snapshot(await blobBytes(repoRoot, blob, remaining()));
    return { source, path: copy.path, bytes: copy.bytes, sha256: baselineFileHash(blob) };
  },
  async parentFile() { throw refuseContext(SHARED_ATTACH_REFUSAL); },
};

/** The copies in the worker's data directory are intact. A missing baseline copy is rebuilt from its blob. */
export async function verifySharedContext(options: {
  repoRoot: string; dataDir: string; parentId: string; workspace: SharedWorkerWorkspace; context?: WorkerInputRecipe | undefined;
}): Promise<void> {
  const { repoRoot, dataDir, workspace } = options;
  const intact = (input: WorkerInput, bytes: Buffer) =>
    bytes.length === input.bytes && baselineFileHash(blobIdOf(bytes, workspace.baselineSha)) === input.sha256;
  await verifyWorkerContext(options, async (input, index) => {
    if (input.source.kind !== 'baseline-file' || input.path !== await parentFileSnapshotPath(dataDir, workspace, index)) throw invalidContext();
    const copy = await canonicalFile(input.path).then(() => readBoundedContextFile(input.path, input.bytes), (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return undefined;
    });
    if (copy) { if (!intact(input, copy)) throw invalidContext(); return; }
    const bytes = await blobBytes(repoRoot, await baselineBlob(repoRoot, workspace.baselineSha, input.source.path), input.bytes);
    if (!intact(input, bytes)) throw invalidContext();
    await writeWorkerDataFile(input.path, bytes);
  });
}
