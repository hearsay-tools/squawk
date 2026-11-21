import { readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

/**
 * What `getRepoInfo` reads, as file metadata: the `.git` entry Git discovers from `dir`, the
 * `HEAD` that names the branch, and the config files that define the remote. Git rewrites each of
 * them through a lock file and a rename, so a branch switch or a remote change gives a new stamp.
 * Reading the stamp starts no process (hearsay-tools/squawk#3651, hearsay-tools/squawk#3658).
 */
export type GitDirStamp =
  /** `dir` is inside a work tree whose `.git` was found; `key` changes when its branch or remote can. */
  | { kind: 'repo'; key: string; root: string; configs: string[] }
  /** No `.git` exists in `dir` or any ancestor, so Git finds no work tree either. */
  | { kind: 'none'; key: string };

const MISSING = new Set(['ENOENT', 'ENOTDIR']);

/** One file's identity and last change; `-` when it does not exist. */
async function fileSignature(path: string): Promise<string> {
  try {
    const s = await stat(path, { bigint: true });
    return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
  } catch (error) {
    if (MISSING.has((error as NodeJS.ErrnoException).code ?? '')) return '-';
    throw error;
  }
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (MISSING.has((error as NodeJS.ErrnoException).code ?? '')) return undefined;
    throw error;
  }
}

/** The signature of each file, joined: it changes when any of them is created, removed or rewritten. */
export async function configFilesKey(files: readonly string[]): Promise<string> {
  return (await Promise.all(files.map(async (file) => `${file}=${await fileSignature(file)}`))).join('|');
}

/**
 * The global and system config files Git may read. A superset is safe: a file Git skips only
 * adds a `stat`, so `GIT_CONFIG_NOSYSTEM` is not interpreted here.
 */
function sharedConfigFiles(env: NodeJS.ProcessEnv): string[] {
  // Git itself finds these through `$HOME`; without it Git reads no global file either.
  const home = env.HOME;
  const xdg = env.XDG_CONFIG_HOME || (home ? join(home, '.config') : undefined);
  return [
    ...(env.GIT_CONFIG_GLOBAL ? [env.GIT_CONFIG_GLOBAL] : []),
    ...(xdg ? [join(xdg, 'git', 'config')] : []),
    ...(home ? [join(home, '.gitconfig')] : []),
    env.GIT_CONFIG_SYSTEM || '/etc/gitconfig',
  ];
}

/** Config Git takes from the environment (`git -c`, `GIT_CONFIG_COUNT`): no file records it. */
function envConfig(env: NodeJS.ProcessEnv): string {
  const pairs = Object.entries(env)
    .filter(([name]) => /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(name))
    .sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify([env.GIT_CONFIG_PARAMETERS ?? '', env.GIT_CONFIG_COUNT ?? '', env.GIT_CONFIG_NOSYSTEM ?? '', ...pairs]);
}

/** Where an include value points, as Git resolves it: `~/` from `$HOME`, relative from the including file. */
function includeTarget(value: string, from: string, env: NodeJS.ProcessEnv): string | undefined {
  if (value.startsWith('~/')) return env.HOME ? join(env.HOME, value.slice(2)) : undefined;
  return value ? resolve(from, value) : undefined;
}

/**
 * The files `git config --list --show-origin -z` (run in `root`) names: every file Git read, and
 * every `include.path` / `includeIf.<condition>.path` target, read or not, so an include that is
 * empty, missing or inactive today still counts when it changes. Git parses its own syntax
 * (quotes, continuations, comments, includes from the environment), so no file is parsed here.
 */
export function configFilesFromListing(listing: string, root: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const files = new Set<string>();
  const tokens = listing.split('\0');
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const origin = tokens[i]!;
    const entry = tokens[i + 1]!;
    const file = origin.startsWith('file:') ? resolve(root, origin.slice('file:'.length)) : undefined;
    if (file) files.add(file);
    const newline = entry.indexOf('\n');
    if (newline < 0 || !/^include(?:if\..*)?\.path$/is.test(entry.slice(0, newline))) continue;
    const target = includeTarget(entry.slice(newline + 1), file ? dirname(file) : root, env);
    if (target) files.add(isAbsolute(target) ? target : resolve(root, target));
  }
  return [...files].sort();
}

/**
 * What `HEAD` names, as a stamp part, or undefined when only Git can tell: a branch ref that is
 * itself a symbolic ref (Git follows the chain, and rewriting the branch ref leaves `HEAD` alone).
 * A reftable repository keeps its refs in `reftable/`, so its table list joins the stamp.
 */
async function headTarget(gitDir: string, commonDir: string): Promise<string | undefined> {
  const head = (await readOptional(join(gitDir, 'HEAD')))?.trim() ?? '';
  const tables = await fileSignature(join(commonDir, 'reftable', 'tables.list'));
  if (tables !== '-') return `reftable=${tables}`;
  const ref = /^ref:\s*(\S+)$/.exec(head)?.[1];
  if (!ref) return 'detached';
  const target = await readOptional(join(commonDir, ref)) ?? await readOptional(join(gitDir, ref));
  return target?.startsWith('ref:') ? undefined : ref;
}

/** The nearest `.git` at or above `dir`, as Git's discovery walks; undefined when there is none. */
async function findDotGit(dir: string): Promise<{ path: string; isFile: boolean } | undefined> {
  let current = resolve(dir);
  for (;;) {
    const path = join(current, '.git');
    try {
      const s = await stat(path);
      if (s.isDirectory() || s.isFile()) return { path, isFile: s.isFile() };
    } catch (error) {
      if (!MISSING.has((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** The Git directory a `.git` entry names: itself, or the `gitdir:` target of a `.git` file. */
async function resolveGitDir(dotGit: { path: string; isFile: boolean }): Promise<{ gitDir: string; pointer: string } | undefined> {
  if (!dotGit.isFile) return { gitDir: dotGit.path, pointer: '' };
  const pointer = (await readFile(dotGit.path, 'utf8')).trim();
  const match = /^gitdir:\s*(.+)$/m.exec(pointer);
  return match?.[1] ? { gitDir: resolve(dirname(dotGit.path), match[1].trim()), pointer } : undefined;
}

/**
 * The stamp of `dir`, or undefined when it cannot be read with confidence (a `.git` file without a
 * `gitdir:` line, a Git directory without `HEAD`, a symbolic branch ref, an unreadable path).
 * Undefined means: ask Git. `configs` lists the config files known without Git; the caller adds
 * the ones Git reports (`configFilesFromListing`).
 */
export async function readGitDirStamp(dir: string, env: NodeJS.ProcessEnv = process.env): Promise<GitDirStamp | undefined> {
  try {
    const environment = envConfig(env);
    const dotGit = await findDotGit(dir);
    if (!dotGit) return { kind: 'none', key: environment };
    const resolved = await resolveGitDir(dotGit);
    if (!resolved) return undefined;
    const { gitDir, pointer } = resolved;
    const commonPointer = (await readOptional(join(gitDir, 'commondir')))?.trim();
    const commonDir = commonPointer ? resolve(gitDir, commonPointer) : gitDir;
    const head = await fileSignature(join(gitDir, 'HEAD'));
    if (head === '-') return undefined;
    const target = await headTarget(gitDir, commonDir);
    if (target === undefined) return undefined;
    const configs = [join(commonDir, 'config'), join(gitDir, 'config.worktree'), ...sharedConfigFiles(env)];
    const parts = [dotGit.path, await fileSignature(dotGit.path), pointer, gitDir, commonDir, head, target, environment];
    return { kind: 'repo', key: parts.join('|'), root: dirname(dotGit.path), configs };
  } catch {
    return undefined;
  }
}
