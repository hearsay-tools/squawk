import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { RepoResponse, RepoInfo } from '@open-mercato/cezar-contract';
import type { RunQueries } from '../runs/ports.ts';
import { getBranches, getLogWithParents, getTracking } from './git.ts';
import { attributeLog } from './repo-branches.ts';
import { configFilesKey, readGitDirStamp } from './git-dir-stamp.ts';
import { boundedReadCache } from './bounded-read-cache.ts';

const refs = boundedReadCache<Omit<RepoResponse, 'info' | 'status'>>(3_000, 64);
const keys = new Map<string, string>();
export function forgetRepoRead(root: string): void {
  const key = keys.get(root);
  if (key) refs.forget(key);
  keys.delete(root);
}

/** Include all loose refs, packed refs and fetch metadata, including linked worktrees. */
async function refStamp(root: string): Promise<string | undefined> {
  const stamp = await readGitDirStamp(root);
  if (stamp?.kind !== 'repo') return undefined;
  const common = dirname(stamp.configs[0]!);
  const dir = join(common, 'refs');
  try {
    const paths = (await readdir(dir, { recursive: true })).sort().map((path) => join(dir, path));
    return await configFilesKey([join(dirname(stamp.configs[1]!), 'HEAD'), ...paths, join(common, 'reftable', 'tables.list'), join(common, 'packed-refs'), join(common, 'FETCH_HEAD'), ...stamp.configs]);
  } catch { return undefined; }
}

export async function readRepoRefs(info: RepoInfo, baseBranch: string | undefined, queries: Pick<RunQueries, 'listBranchOwners'>) {
  const root = info.root;
  const stamp = await refStamp(root);
  const owners = queries.listBranchOwners();
  const key = createHash('sha256').update(JSON.stringify([root, info, stamp, baseBranch, owners])).digest('hex');
  const load = async () => {
    const [rawLog, branches, tracking] = await Promise.all([
      getLogWithParents(info.root), getBranches(info.root), getTracking(info.root, baseBranch ?? info.branch),
    ]);
    const sources = await attributeLog(info.root, rawLog, owners);
    const log = rawLog.map(({ parents: _parents, ...entry }, i) => sources[i] ? { ...entry, source: sources[i]! } : entry);
    return { log, branches, baseBranch: baseBranch ?? null, tracking };
  };
  if (keys.get(root) !== key) forgetRepoRead(root);
  keys.set(root, key);
  while (keys.size > 64) forgetRepoRead(keys.keys().next().value!);
  return await (stamp ? refs.read(key, load) : load());
}
