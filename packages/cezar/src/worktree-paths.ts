import { lstat, realpath, readFile, mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { runGit } from './git-command.ts';

/**
 * Where `path` really lands: the realpath of its nearest existing ancestor (the
 * path itself when it exists), through every symlink, plus the segments below
 * it. Null when that ancestor cannot be resolved, a dangling link among them.
 */
async function landingPath(path: string): Promise<string | null> {
  const below: string[] = [];
  for (let at = resolve(path); ; at = dirname(at)) {
    if (await lstat(at).then(() => true, () => false)) {
      const real = await realpath(at).catch(() => null);
      return real === null ? null : join(real, ...below.reverse());
    }
    if (dirname(at) === at) return null;
    below.push(basename(at));
  }
}

/** `path` lands inside `root`, itself a realpath. */
export async function landsInside(root: string, path: string): Promise<boolean> {
  const landing = await landingPath(path);
  return landing !== null && (landing === root || landing.startsWith(root.endsWith(sep) ? root : root + sep));
}

export async function excludeFromGit(repoRoot: string, pattern: string): Promise<boolean> {
  try {
    // Resolve the real exclude file: in a linked worktree (spec 006) `.git`
    // is a file and `info/exclude` lives in the shared common dir — which
    // also means one exclude entry covers every task worktree.
    const probe = await runGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: repoRoot, timeout: 10_000 });
    const gitDir = probe.stdout.trim() || join(repoRoot, '.git');
    const excludePath = join(gitDir, 'info', 'exclude');
    let prev = '';
    try {
      prev = await readFile(excludePath, 'utf8');
    } catch {
      // no exclude file yet
    }
    if (prev.split('\n').includes(pattern)) return true;
    await mkdir(dirname(excludePath), { recursive: true });
    await writeFile(excludePath, prev + (prev && !prev.endsWith('\n') ? '\n' : '') + pattern + '\n', 'utf8');
    return true;
  } catch {
    // non-fatal — `.git` might be a linked file (worktree) or absent entirely
    return false;
  }
}
