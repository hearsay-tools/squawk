import { readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

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

/** Config Git takes from the environment (`git -c`, `GIT_CONFIG_COUNT`): no file records it. */
function envConfig(env: NodeJS.ProcessEnv): string {
  const pairs = Object.entries(env)
    .filter(([name]) => /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(name))
    .sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify([env.GIT_CONFIG_PARAMETERS ?? '', env.GIT_CONFIG_COUNT ?? '', ...pairs]);
}

/** A config value as Git reads it: quotes removed, `\\` escapes applied, a `#` or `;` comment cut. */
function configValue(raw: string): string {
  let value = '';
  let quoted = false;
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i]!;
    if (char === '\\') value += raw[++i] ?? '';
    else if (char === '"') quoted = !quoted;
    else if (!quoted && (char === '#' || char === ';')) break;
    else value += char;
  }
  return value.trim();
}

/** The `path` values of a config file's `[include]` and `[includeIf]` sections, as Git resolves them. */
function includePaths(text: string, file: string, env: NodeJS.ProcessEnv): string[] {
  const paths: string[] = [];
  let including = false;
  for (const raw of text.split('\n')) {
    let line = raw.trim();
    const header = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"(?:[^"\\]|\\.)*")?\s*\]/.exec(line);
    if (header) {
      including = /^include(if)?$/i.test(header[1]!);
      line = line.slice(header[0].length).trim();
    }
    const entry = including ? /^path\s*=\s*(.*)$/i.exec(line) : null;
    if (!entry) continue;
    const value = configValue(entry[1]!);
    if (!value) continue;
    if (value.startsWith('~/')) {
      if (env.HOME) paths.push(join(env.HOME, value.slice(2)));
    } else {
      paths.push(isAbsolute(value) ? value : resolve(dirname(file), value));
    }
  }
  return paths;
}

/** Each config file and every file it includes, conditional or not, with its signature. */
async function configSignatures(files: string[], env: NodeJS.ProcessEnv): Promise<string[]> {
  const seen = new Set<string>();
  const out: string[] = [];
  // Git stops at 10 levels of nested includes.
  let level = files;
  for (let depth = 0; depth <= 10 && level.length > 0; depth++) {
    const next: string[] = [];
    for (const file of level) {
      if (seen.has(file)) continue;
      seen.add(file);
      out.push(`${file}=${await fileSignature(file)}`);
      const text = await readOptional(file);
      if (text && /\[\s*include/i.test(text)) next.push(...includePaths(text, file, env));
    }
    level = next;
  }
  return out;
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
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
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
 * Undefined means: ask Git.
 */
export async function readGitDirStamp(dir: string, env: NodeJS.ProcessEnv = process.env): Promise<GitDirStamp | undefined> {
  try {
    const environment = envConfig(env);
    const dotGit = await findDotGit(dir);
    if (!dotGit) return { kind: 'none', key: [environment, ...await configSignatures(sharedConfigFiles(env), env)].join('|') };
    const resolved = await resolveGitDir(dotGit);
    if (!resolved) return undefined;
    const { gitDir, pointer } = resolved;
    const commonPointer = (await readOptional(join(gitDir, 'commondir')))?.trim();
    const commonDir = commonPointer ? resolve(gitDir, commonPointer) : gitDir;
    const head = await fileSignature(join(gitDir, 'HEAD'));
    if (head === '-') return undefined;
    const target = await headTarget(gitDir, commonDir);
    if (target === undefined) return undefined;
    const configs = await configSignatures([join(commonDir, 'config'), join(gitDir, 'config.worktree'), ...sharedConfigFiles(env)], env);
    const parts = [dotGit.path, await fileSignature(dotGit.path), pointer, gitDir, commonDir, head, target, environment, ...configs];
    return { kind: 'repo', key: parts.join('|') };
  } catch {
    return undefined;
  }
}
