import { readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

/**
 * What `getRepoInfo` reads, as file metadata: the `.git` entry Git discovers from `dir`, the
 * `HEAD` that names the branch, and the config files that define the remote. Git rewrites each of
 * them through a lock file and a rename, so a branch switch or a remote change gives a new stamp.
 * Reading the stamp starts no process (hearsay-tools/squawk#3651, hearsay-tools/squawk#3658).
 */
export type GitDirStamp =
  /** `dir` is inside a work tree whose `.git` was found; the string changes when its branch or remote can. */
  | { kind: 'repo'; key: string }
  /** No `.git` exists in `dir` or any ancestor, so Git finds no work tree either. */
  | { kind: 'none'; key: string };

/** One file's identity and last change; `-` when it does not exist. */
async function fileSignature(path: string): Promise<string> {
  try {
    const s = await stat(path, { bigint: true });
    return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return '-';
    throw error;
  }
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return undefined;
    throw error;
  }
}

/** The global and system config files Git reads for `url.<base>.insteadOf` and `safe.directory`. */
function sharedConfigFiles(env: NodeJS.ProcessEnv): string[] {
  // Git itself finds these through `$HOME`; without it Git reads no global file either.
  const home = env.HOME;
  const xdg = env.XDG_CONFIG_HOME || (home ? join(home, '.config') : undefined);
  const global = env.GIT_CONFIG_GLOBAL
    ? [env.GIT_CONFIG_GLOBAL]
    : [...(xdg ? [join(xdg, 'git', 'config')] : []), ...(home ? [join(home, '.gitconfig')] : [])];
  const system = env.GIT_CONFIG_NOSYSTEM ? [] : [env.GIT_CONFIG_SYSTEM || '/etc/gitconfig'];
  return [...global, ...system];
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
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/**
 * The stamp of `dir`, or undefined when it cannot be read with confidence (a `.git` file without a
 * `gitdir:` line, a Git directory without `HEAD`, an unreadable path). Undefined means: ask Git.
 */
export async function readGitDirStamp(dir: string, env: NodeJS.ProcessEnv = process.env): Promise<GitDirStamp | undefined> {
  try {
    const shared = await Promise.all(sharedConfigFiles(env).map(fileSignature));
    const dotGit = await findDotGit(dir);
    if (!dotGit) return { kind: 'none', key: shared.join('|') };
    let gitDir = dotGit.path;
    let pointer = '';
    if (dotGit.isFile) {
      pointer = (await readFile(dotGit.path, 'utf8')).trim();
      const match = /^gitdir:\s*(.+)$/m.exec(pointer);
      if (!match?.[1]) return undefined;
      gitDir = resolve(dirname(dotGit.path), match[1].trim());
    }
    const commonPointer = (await readOptional(join(gitDir, 'commondir')))?.trim();
    const commonDir = commonPointer ? resolve(gitDir, commonPointer) : gitDir;
    const head = await fileSignature(join(gitDir, 'HEAD'));
    if (head === '-') return undefined;
    const files = await Promise.all([
      fileSignature(dotGit.path),
      fileSignature(join(commonDir, 'config')),
      fileSignature(join(gitDir, 'config.worktree')),
    ]);
    return { kind: 'repo', key: [dotGit.path, pointer, gitDir, commonDir, head, ...files, ...shared].join('|') };
  } catch {
    return undefined;
  }
}
