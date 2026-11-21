import { readdir, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { isSafeGitRef } from '../git-refs.ts';
import { runGit } from '../git-command.ts';
import { configFilesFromListing, configFilesKey, readGitDirStamp, type GitDirStamp } from './git-dir-stamp.ts';

export interface RepoInfo {
  root: string;
  branch: string;
  remote?: string | undefined;
}

export interface StatusEntry {
  status: string;
  path: string;
}

export interface LogEntry {
  hash: string;
  subject: string;
  author: string;
  when: string;
  /** Committer date, strict ISO 8601 (`%cI`) — what the cockpit groups by day. */
  at: string;
}

/** A log row plus its full parent SHAs — what `source` attribution reads (issue 08 §B5). The
 *  parents never reach the wire: the route maps them away. */
export interface LogEntryWithParents extends LogEntry {
  parents: string[];
}

/** `GET /repo` `tracking` (issue 08 §B1). */
export interface RepoTracking {
  ref: string;
  ahead: number;
  behind: number;
  fetchedAt: string | null;
}

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await runGit(args, { cwd: root, maxBuffer: 10 * 1024 * 1024 });
  return stdout;
}

/** Entries kept by `getRepoInfo`: one per directory asked about (project roots, the boot root). */
const REPO_INFO_CACHE_MAX = 512;

/** One Git answer with what it depends on: the config files Git read, and their signatures then. */
interface RepoInfoRead { info: RepoInfo | null; configs: string[]; configsKey: string | undefined; keep: boolean }
const repoInfoCache = new Map<string, { stamp: string; read: Promise<RepoInfoRead> }>();

const stampKey = (stamp: GitDirStamp | undefined) => stamp && `${stamp.kind}:${stamp.key}`;
/** The config files' key, or undefined when one cannot be read (EACCES, EIO): then nothing is kept. */
const readConfigsKey = (configs: readonly string[]) => configFilesKey(configs).catch(() => undefined);
const copy = (info: RepoInfo | null) => info && { ...info };

/**
 * Null when `dir` isn't inside a git repository. The answer is kept per directory while
 * `readGitDirStamp` and the signatures of every config file Git read stay the same: a repeat call
 * reads only file metadata and starts no `git` process. Each process start forks this large
 * server process (hearsay-tools/squawk#3651, hearsay-tools/squawk#3658). A branch switch or a
 * remote change rewrites one of those files, so the next call asks Git again.
 */
export async function getRepoInfo(dir: string): Promise<RepoInfo | null> {
  const stamp = await readGitDirStamp(dir);
  if (!stamp) return (await readRepoInfo(dir)).info;
  const key = stampKey(stamp)!;
  const cached = repoInfoCache.get(dir);
  if (cached?.stamp === key) {
    const hit = await cached.read;
    if (hit.keep && await readConfigsKey(hit.configs) === hit.configsKey) return copy(hit.info);
  }
  const entry = { stamp: key, read: readKeepable(dir, stamp) };
  repoInfoCache.delete(dir);
  if (repoInfoCache.size >= REPO_INFO_CACHE_MAX) repoInfoCache.delete(repoInfoCache.keys().next().value!);
  repoInfoCache.set(dir, entry);
  const read = await entry.read;
  if (!read.keep && repoInfoCache.get(dir) === entry) repoInfoCache.delete(dir);
  return copy(read.info);
}

/** The config files Git reads in `root`, as `git config --list --show-origin` reports them. */
async function gitConfigFiles(root: string): Promise<string[] | undefined> {
  try {
    return configFilesFromListing(await git(root, ['config', '--list', '--show-origin', '-z']), root);
  } catch {
    return undefined;
  }
}

/**
 * Ask Git, and decide whether the answer may be kept. It may when the metadata explains it (a
 * repository where a `.git` was found, or null where none exists), remote discovery finished, and
 * no watched file changed while Git ran. Null beside a `.git` (an unborn HEAD before its first
 * commit, a missing `git`) can change with no watched file changing, so it is asked again.
 */
async function readKeepable(dir: string, stamp: GitDirStamp): Promise<RepoInfoRead> {
  const reported = stamp.kind === 'repo' ? await gitConfigFiles(stamp.root) : [];
  const configs = [...new Set([...(stamp.kind === 'repo' ? stamp.configs : []), ...(reported ?? [])])].sort();
  const configsKey = await readConfigsKey(configs);
  const { info, complete } = await readRepoInfo(dir);
  const explained = (info === null) === (stamp.kind === 'none');
  const keep = reported !== undefined && configsKey !== undefined && complete && explained
    && stampKey(await readGitDirStamp(dir)) === stampKey(stamp)
    && await readConfigsKey(configs) === configsKey;
  return { info, configs, configsKey, keep };
}

/** Git's answer, and whether remote discovery finished (a failed `git remote` is not "no remote"). */
async function readRepoInfo(dir: string): Promise<{ info: RepoInfo | null; complete: boolean }> {
  try {
    const output = (await git(dir, ['rev-parse', '--show-toplevel', '--abbrev-ref', 'HEAD'])).trim();
    const split = output.lastIndexOf('\n');
    if (split < 0) return { info: null, complete: true };
    const root = output.slice(0, split);
    const branch = output.slice(split + 1);
    let remote: string | undefined;
    let complete = true;
    try {
      remote = (await git(root, ['remote', 'get-url', 'origin'])).trim() || undefined;
    } catch {
      // No remote named `origin` — fall back to the first configured remote,
      // so repos whose only remote is named e.g. `github` or `upstream` still
      // get forge detection. A repo with no remote lists none.
      try {
        const names = (await git(root, ['remote'])).split('\n').map((n) => n.trim()).filter(Boolean);
        if (names[0]) {
          remote = (await git(root, ['remote', 'get-url', names[0]])).trim() || undefined;
        }
      } catch {
        // `git remote` itself failed: the remote is unknown, not absent.
        complete = false;
      }
    }
    return { info: { root, branch, remote }, complete };
  } catch {
    return { info: null, complete: true };
  }
}

/** Resolve an owned branch without depending on a retained worktree. */
export async function getBranchHead(root: string, branch: string): Promise<string | undefined> {
  if (!isSafeGitRef(branch)) return undefined;
  try {
    const sha = (await git(root, ['rev-parse', '--verify', `refs/heads/${branch}^{commit}`])).trim();
    return /^[a-f0-9]{40,64}$/i.test(sha) ? sha : undefined;
  } catch { return undefined; }
}

/** The current commit, pinned as a full SHA. Null outside a repository or before its first commit. */
export async function getHeadCommit(root: string): Promise<string | null> {
  try {
    return (await git(root, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim() || null;
  } catch {
    return null;
  }
}

export async function getStatus(root: string): Promise<StatusEntry[]> {
  const out = await git(root, ['status', '--porcelain', '--untracked-files=all']);
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => ({ status: line.slice(0, 2).trim() || '??', path: line.slice(3) }));
}

/** Working-tree diff vs HEAD (staged + unstaged), capped for the GUI. */
export async function getDiff(root: string, cap = 400_000): Promise<string> {
  const diff = await git(root, ['diff', 'HEAD']);
  if (diff.length > cap) return `${diff.slice(0, cap)}\n… (diff truncated)`;
  return diff;
}

/** Local + origin branch names, deduped (origin/x counts as x), sorted.
 *  Feeds the Repo tab's base-branch picker. */
export async function getBranches(root: string): Promise<string[]> {
  const names = new Set<string>();
  try {
    const local = await git(root, ['branch', '--list', '--format=%(refname:short)']);
    for (const line of local.split('\n')) {
      const name = line.trim();
      if (name) names.add(name);
    }
  } catch {
    // no branches — empty list
  }
  try {
    const remote = await git(root, ['branch', '-r', '--list', '--format=%(refname:short)']);
    for (const line of remote.split('\n')) {
      const name = line.trim();
      if (!name || name.includes('HEAD')) continue;
      names.add(name.replace(/^origin\//, ''));
    }
  } catch {
    // no remotes — local only
  }
  return [...names].filter((n) => !n.startsWith('cez/')).sort((a, b) => a.localeCompare(b));
}

/** One commit — message + stat + patch — for the Repo view's expandable rows. */
export async function getCommit(root: string, sha: string, cap = 200_000): Promise<string> {
  if (!/^[0-9a-f]{4,40}$/i.test(sha)) return '(not a commit hash)';
  const out = await git(root, ['show', '--stat', '--patch', '--no-color', sha]);
  if (out.length > cap) return `${out.slice(0, cap)}\n… (diff truncated)`;
  return out;
}

export async function getLog(root: string, count = 20): Promise<LogEntry[]> {
  return (await getLogWithParents(root, count)).map(({ parents: _parents, ...entry }) => entry);
}

export async function getLogWithParents(root: string, count = 20): Promise<LogEntryWithParents[]> {
  const out = await git(root, [
    'log',
    `-${count}`,
    '--pretty=format:%h%x1f%s%x1f%an%x1f%cr%x1f%cI%x1f%P',
  ]);
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash = '', subject = '', author = '', when = '', at = '', parents = ''] = line.split('\x1f');
      return { hash, subject, author, when, at, parents: parents.split(' ').filter(Boolean) };
    });
}

/**
 * The base branch against its upstream, as of the LAST FETCH (issue 08 §B1). Reads refs only —
 * never `fetch`, never the network — so it is as fresh as whatever last fetched, which is usually
 * an agent (agents fetch, they never pull). Null when the base has no upstream or git cannot say;
 * never throws.
 */
export async function getTracking(root: string, base: string): Promise<RepoTracking | null> {
  if (!isSafeGitRef(base)) return null;
  try {
    const ref = (await git(root, ['for-each-ref', '--format=%(upstream:short)', `refs/heads/${base}`])).trim();
    if (!ref) return null;
    const counts = (await git(root, ['rev-list', '--left-right', '--count', `refs/heads/${base}...${ref}`])).trim();
    const [ahead, behind] = counts.split(/\s+/).map(Number);
    if (!Number.isFinite(ahead) || !Number.isFinite(behind)) return null;
    return { ref, ahead: ahead as number, behind: behind as number, fetchedAt: await lastFetchedAt(root) };
  } catch {
    return null;
  }
}

/** The newest `FETCH_HEAD` mtime in the repository. Each linked worktree writes its OWN
 *  (`<common>/worktrees/<name>/FETCH_HEAD`), and agents fetch from task worktrees, so the main
 *  checkout's alone would say "never fetched" right after an agent refreshed `origin/main`. */
async function lastFetchedAt(root: string): Promise<string | null> {
  try {
    const common = (await git(root, ['rev-parse', '--git-common-dir'])).trim();
    const dir = isAbsolute(common) ? common : join(root, common);
    const linked = await readdir(join(dir, 'worktrees')).catch(() => [] as string[]);
    const files = [join(dir, 'FETCH_HEAD'), ...linked.map((name) => join(dir, 'worktrees', name, 'FETCH_HEAD'))];
    const times = await Promise.all(files.map((file) => stat(file).then((s) => s.mtimeMs, () => null)));
    const newest = Math.max(...times.filter((t): t is number => t !== null));
    return Number.isFinite(newest) ? new Date(newest).toISOString() : null;
  } catch {
    return null;
  }
}
