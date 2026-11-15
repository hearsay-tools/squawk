import {
  execFile, execFileSync, spawn,
  type ChildProcess, type ChildProcessByStdio, type ExecFileException, type ExecFileOptions, type ExecFileSyncOptions,
  type SpawnOptions, type SpawnOptionsWithStdioTuple, type StdioNull, type StdioPipe,
} from 'node:child_process';
import type { Readable } from 'node:stream';

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** True when git wrote more than `maxBuffer`; `stdout` then holds only the start of it. */
  overflow: boolean;
}

export interface GitOptions {
  timeout?: number;
  /** Set over the cleaned process env, so a caller's own value (a private `GIT_INDEX_FILE`) wins. */
  env?: Record<string, string>;
  maxBuffer?: number;
}

const MAX_BUFFER_MIB = 32;

/** The reason a caller reports when `overflow` is true. */
export const GIT_OVERFLOW_REASON = `the diff is too large: git output is over the ${MAX_BUFFER_MIB} MiB limit`;

/** Variables that point git at a repository or index. A server started from a Git hook or a
 *  `rebase --exec` step inherits them, and git would then ignore `cwd` (hearsay-tools/squawk#3207). */
const LOCATION_VARS = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_PREFIX',
];

/** The process env without the location variables, with `overrides` on top. */
export function gitEnv(overrides: Record<string, string | undefined> = {}, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...source };
  for (const name of LOCATION_VARS) delete env[name];
  return { ...env, ...overrides };
}

/** The env of every helper below: `env` is set over `baseEnv` (default `process.env`) without its
 *  location variables, so a caller's own value (a private `GIT_INDEX_FILE`) wins. */
export interface GitEnvOptions {
  env?: Record<string, string | undefined> | undefined;
  baseEnv?: NodeJS.ProcessEnv | undefined;
}

function withGitEnv<T extends GitEnvOptions>(options: T): Omit<T, keyof GitEnvOptions> & { env: NodeJS.ProcessEnv } {
  const { env, baseEnv, ...rest } = options;
  return { ...rest, env: gitEnv(env, baseEnv) };
}

export type RunGitOptions = Omit<ExecFileOptions, 'env' | 'encoding'> & GitEnvOptions & {
  /** Written to git's stdin, which is then closed. Without it stdin stays open, as `execFile` leaves it. */
  input?: string | undefined;
};

/** The rejection of `runGit`: `execFile`'s error with git's output, as `promisify(execFile)` gives it. */
export type RunGitError = ExecFileException & { stdout: string; stderr: string };

/** Run git and resolve its output; reject with a `RunGitError` when it fails. */
export function runGit(args: readonly string[], options: RunGitOptions = {}): Promise<{ stdout: string; stderr: string }> {
  const { input, ...rest } = options;
  return new Promise((resolve, reject) => {
    const child = execFile('git', args, { ...withGitEnv(rest), encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
    // A git that exits early closes its stdin; that EPIPE belongs to the rejection above.
    if (input !== undefined) child.stdin?.on('error', () => undefined).end(input);
  });
}

export type GitSyncOptions = Omit<ExecFileSyncOptions, 'env' | 'encoding'> & GitEnvOptions;

/** Run git synchronously and return its stdout; throw `execFileSync`'s error when it fails. */
export function gitSync(args: readonly string[], options: GitSyncOptions = {}): string {
  return execFileSync('git', args, { ...withGitEnv(options), encoding: 'utf8' });
}

export type SpawnGitOptions = Omit<SpawnOptions, 'env'> & GitEnvOptions;

/** Start git for a caller that reads its streams or owns its lifetime. */
export function spawnGit(
  args: readonly string[], options: Omit<SpawnOptionsWithStdioTuple<StdioNull, StdioPipe, StdioPipe>, 'env'> & GitEnvOptions,
): ChildProcessByStdio<null, Readable, Readable>;
export function spawnGit(args: readonly string[], options?: SpawnGitOptions): ChildProcess;
export function spawnGit(args: readonly string[], options: SpawnGitOptions = {}): ChildProcess {
  return spawn('git', args, withGitEnv(options));
}

/** Run git in `cwd`, never throw — degradation is the caller's policy. */
export function git(cwd: string, args: string[], options: GitOptions = {}): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      {
        cwd,
        encoding: 'utf8',
        maxBuffer: options.maxBuffer ?? MAX_BUFFER_MIB * 1024 * 1024,
        timeout: options.timeout,
        env: gitEnv(options.env),
      },
      (err, stdout, stderr) => resolve({
        ok: !err,
        stdout: stdout ?? '',
        stderr: stderr ?? '',
        overflow: err?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
      }),
    );
  });
}
