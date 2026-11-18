/** The recorded state of a directory a worker shares with its host, and the report of what changed
 *  between two states. Reads only: `--no-optional-locks` keeps `git status` from refreshing the index. */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, readFile, readlink, realpath, rm, stat } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { z } from 'zod';
import { WORKER_CHANGED_PATHS_CAP, type WorkerChangeReport } from '@open-mercato/cezar-contract/delegation';
import { git } from '../git-command.ts';
import { entryExists } from './entry-exists.ts';
import { workerDataDirectory, writeWorkerDataFile } from './context.ts';

/** How many status entries one recorded state keeps; one hash covers the rest. */
export const STATE_ENTRY_CAP = 5_000;
const STATE_FILE_BYTES = 16 * 1024 * 1024;
/** A changed or untracked file up to this size is compared by content; a larger one by size, modification time and mode. */
export const CONTENT_HASH_FILE_BYTES = 8 * 1024 * 1024;
/** The content one recorded state hashes in total; files past it are compared by size, modification time and mode. */
export const CONTENT_HASH_TOTAL_BYTES = 64 * 1024 * 1024;
/** How deep a state follows nested repositories (submodules); a deeper one is compared by its HEAD only. */
const NESTED_REPOSITORY_DEPTH = 3;
const READ_CHUNK_BYTES = 64 * 1024;
const START_FILE = 'worker-workspace-start.json';
const END_PREFIX = 'worker-workspace-end.';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

type Entry = {
  path: string;
  /** The status code, with the source path of a rename or copy. */
  code: string;
  /** Size, modification time and mode; `absent` for a path with nothing at it. Always recorded. */
  meta: string;
  /** The content: a file's hash with its executable bit, a link's target, a nested repository's HEAD. Left out when the
   *  content was not read: the file is past a size bound, or its directory is outside the workspace. */
  content?: string | undefined;
  /** The state of a nested repository (a submodule). */
  nested?: WorkspaceState | undefined;
};
export type WorkspaceState = {
  head: string;
  /** The checked-out branch; null for a detached HEAD. */
  branch: string | null;
  /** SHA-256 of `git ls-files -s -z`: what the index holds, not the bytes of its file. */
  index: string;
  /** Status entries sorted by path, at most `STATE_ENTRY_CAP`. */
  entries: Entry[];
  /** SHA-256 of the code and metadata of every entry past the cap; null when none is. */
  overflow: string | null;
};
const entrySchema: z.ZodType<Entry> = z.lazy(() => z.object({
  path: z.string(), code: z.string(), meta: z.string(), content: z.string().optional(), nested: stateSchema.optional(),
}).strict());
const stateSchema: z.ZodType<WorkspaceState> = z.lazy(() => z.object({
  head: z.string().min(1), branch: z.string().nullable(), index: z.string().length(64),
  entries: z.array(entrySchema).max(STATE_ENTRY_CAP), overflow: z.string().length(64).nullable(),
}).strict());
/** An end state belongs to one execution generation: a capture of an older one is never read as the end of the current one. */
const endSchema = z.object({ generation: z.string().min(1), state: stateSchema }).strict();

async function gitOutput(dir: string, args: string[]): Promise<string> {
  const result = await git(dir, ['--no-optional-locks', ...args], { timeout: 60_000 });
  if (!result.ok) throw new Error(`git ${args[0]} failed in the shared workspace${result.overflow ? ': its output is too large' : ''}`);
  return result.stdout;
}

/** `git status --porcelain=v1 -z` as `[path, code]` pairs. A rename or copy names its source after the entry. */
export function parseStatus(output: string): Array<[string, string]> {
  const tokens = output.split('\0');
  const entries: Array<[string, string]> = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.length < 4) continue;
    const code = token.slice(0, 2);
    const source = /[RC]/.test(code) ? tokens[++index] : undefined;
    entries.push([token.slice(3), source === undefined ? code : `${code} ${source}`]);
  }
  return entries;
}

/**
 * The SHA-256 of a regular file whose last path component is no link, read in chunks, and never
 * past `limit` plus one chunk: a file that grew or was replaced after its size was read cannot make
 * the read larger. Undefined when the path is no regular file, cannot be opened, or holds more
 * than `limit` bytes. `read` is how many bytes were read.
 */
export async function boundedContentHash(path: string, limit: number): Promise<{ hash?: string; read: number }> {
  // Windows has no O_NOFOLLOW or O_NONBLOCK: there the check of the last component is this lstat alone.
  const last = await lstat(path).catch(() => undefined);
  if (!last?.isFile()) return { read: 0 };
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)).catch(() => undefined);
  if (!handle) return { read: 0 };
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > limit) return { read: 0 };
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(READ_CHUNK_BYTES);
    let read = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, read);
      if (!bytesRead) return { hash: hash.digest('hex'), read };
      read += bytesRead;
      if (read > limit) return { read };
      hash.update(buffer.subarray(0, bytesRead));
    }
  } catch { return { read: 0 }; } finally { await handle.close(); }
}

type Capture = { root: string; budget: number };
const inside = (root: string, path: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

/** One status entry. Content is read only where the entry's real directory is inside the workspace
 *  root, so a directory replaced by a link never leads a read out of it. */
async function captureEntry(dir: string, path: string, code: string, capture: Capture, depth: number, readContent: boolean): Promise<Entry> {
  const target = join(dir, path);
  const info = await lstat(target).catch(() => undefined);
  if (!info) return { path, code, meta: 'absent' };
  const entry: Entry = { path, code, meta: `${info.size}:${info.mtimeMs}:${info.mode}` };
  const parent = await realpath(dirname(target)).catch(() => undefined);
  if (!readContent || !parent || !inside(capture.root, parent)) return entry;
  if (info.isSymbolicLink()) return { ...entry, content: `link:${await readlink(target).catch(() => '')}` };
  if (info.isDirectory()) return { ...entry, ...await captureNested(target, capture, depth) };
  if (!info.isFile()) return entry;
  const { hash, read } = await boundedContentHash(target, Math.min(CONTENT_HASH_FILE_BYTES, capture.budget));
  capture.budget -= Math.min(read, capture.budget);
  return hash === undefined ? entry : { ...entry, content: `sha256:${hash}:${info.mode & 0o111 ? 'x' : '-'}` };
}

/** A directory in the status is a nested repository: a submodule, or an untracked clone. */
async function captureNested(dir: string, capture: Capture, depth: number): Promise<Pick<Entry, 'content' | 'nested'>> {
  const head = await git(dir, ['rev-parse', '--verify', 'HEAD^{commit}'], { timeout: 30_000 });
  if (!head.ok || !await entryExists(join(dir, '.git'))) return {};
  const content = `repository:${head.stdout.trim()}`;
  if (depth >= NESTED_REPOSITORY_DEPTH) return { content };
  const nested = await captureState(dir, capture, depth + 1).catch(() => undefined);
  return nested ? { content, nested } : { content };
}

async function captureState(dir: string, capture: Capture, depth: number): Promise<WorkspaceState> {
  const head = (await gitOutput(dir, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
  const branch = await git(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { timeout: 30_000 });
  const index = sha256(await gitOutput(dir, ['ls-files', '-s', '-z']));
  const parsed = parseStatus(await gitOutput(dir, ['status', '--porcelain=v1', '-z', '--untracked-files=all']))
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const entries: Entry[] = [];
  const overflow = createHash('sha256');
  for (const [position, [path, code]] of parsed.entries()) {
    const kept = position < STATE_ENTRY_CAP;
    const entry = await captureEntry(dir, path, code, capture, depth, kept);
    if (kept) entries.push(entry); else overflow.update(`${path}\0${code}\0${entry.meta}\0`);
  }
  return { head, branch: branch.ok ? branch.stdout.trim() : null, index, entries,
    overflow: parsed.length > STATE_ENTRY_CAP ? overflow.digest('hex') : null };
}

export async function captureWorkspaceState(dir: string): Promise<WorkspaceState> {
  const root = await realpath(dir).catch(() => { throw new Error('the shared workspace directory is gone'); });
  return captureState(dir, { root, budget: CONTENT_HASH_TOTAL_BYTES }, 0);
}

/** Content decides where both states read it; else the metadata, which every entry has. So a path
 *  whose content one state could not read is never listed for that reason alone. */
function entryDiffers(before: Entry | undefined, after: Entry | undefined): boolean {
  if (!before || !after) return true;
  if (before.code !== after.code) return true;
  if (before.nested && after.nested) return stateDiffers(before.nested, after.nested);
  if (before.content !== undefined && after.content !== undefined) return before.content !== after.content;
  return before.meta !== after.meta;
}

function differingPaths(start: WorkspaceState, end: WorkspaceState): string[] {
  const before = new Map(start.entries.map(entry => [entry.path, entry])), after = new Map(end.entries.map(entry => [entry.path, entry]));
  return [...new Set([...before.keys(), ...after.keys()])].filter(path => entryDiffers(before.get(path), after.get(path)));
}

function stateDiffers(start: WorkspaceState, end: WorkspaceState): boolean {
  return start.head !== end.head || start.branch !== end.branch || start.index !== end.index || start.overflow !== end.overflow ||
    differingPaths(start, end).length > 0;
}

async function readJson(path: string): Promise<unknown> {
  if (!await entryExists(path)) return undefined;
  if ((await stat(path)).size > STATE_FILE_BYTES) throw new Error('the recorded workspace state is too large');
  return JSON.parse(await readFile(path, 'utf8'));
}

async function stateFile(dataDir: string, workerId: string, name: string): Promise<string> {
  return join(await workerDataDirectory(dataDir, workerId), name);
}
const endFileName = (generation: string) => `${END_PREFIX}${sha256(generation).slice(0, 32)}.json`;

/** Record the directory's state for the worker's first session. Written once: a later launch or
 *  Continue keeps the first record. */
export async function recordWorkspaceStart(dataDir: string, workerId: string, dir: string): Promise<void> {
  const path = await stateFile(dataDir, workerId, START_FILE);
  if (await entryExists(path)) return;
  await writeWorkerDataFile(path, Buffer.from(JSON.stringify(await captureWorkspaceState(dir))));
}

/** A new execution begins: the end states of earlier generations go. One that an earlier
 *  generation's late capture writes afterwards is never read, and goes at the next call. */
export async function clearWorkspaceEnds(dataDir: string, workerId: string): Promise<void> {
  const directory = await workerDataDirectory(dataDir, workerId);
  for (const name of await readdir(directory).catch(() => [])) {
    if (name.startsWith(END_PREFIX)) await rm(join(directory, name), { force: true });
  }
}

/** Record the directory's state when the execution `generation` of the worker ended. A failed read leaves no end record for the generation, and
 *  the report of the settled worker is then unavailable. Nothing is recorded without a start state. */
export async function recordWorkspaceEnd(dataDir: string, workerId: string, dir: string, generation: string): Promise<void> {
  const directory = await workerDataDirectory(dataDir, workerId);
  const name = endFileName(generation);
  if (!await entryExists(join(directory, START_FILE))) return;
  await rm(join(directory, name), { force: true });
  const state = await captureWorkspaceState(dir);
  await writeWorkerDataFile(join(directory, name), Buffer.from(JSON.stringify({ generation, state })));
}

/** Paths that differ between two states, and paths two commits differ in. */
async function changedPaths(dir: string, start: WorkspaceState, end: WorkspaceState): Promise<string[]> {
  const paths = new Set(differingPaths(start, end));
  if (start.head !== end.head) {
    const committed = await git(dir, ['diff', '--name-only', '-z', '--no-renames', start.head, end.head, '--'], { timeout: 30_000 });
    if (committed.ok) for (const path of committed.stdout.split('\0')) if (path) paths.add(path);
  }
  return [...paths].sort();
}

export async function compareWorkspaceStates(dir: string, start: WorkspaceState, end: WorkspaceState): Promise<WorkerChangeReport> {
  const headMoved = start.head !== end.head, branchMoved = start.branch !== end.branch, indexMoved = start.index !== end.index;
  const overflowMoved = start.overflow !== end.overflow;
  const paths = await changedPaths(dir, start, end);
  if (!headMoved && !branchMoved && !indexMoved && !overflowMoved && paths.length === 0) return { state: 'unchanged' };
  return {
    state: 'changed', paths: paths.slice(0, WORKER_CHANGED_PATHS_CAP),
    truncated: paths.length > WORKER_CHANGED_PATHS_CAP || overflowMoved,
    headMoved, branchMoved, indexMoved,
  };
}

/** What a report compares the start state with: the worker's current execution generation, and
 *  whether that execution ended. */
export type WorkspaceReportTarget = { generation: string | undefined; settled: boolean };

/** What changed in `dir` since the worker's first session started, up to the end of its current
 *  execution generation. Only a worker that still runs is compared with the directory as it is: a
 *  settled worker with no end state of its generation gets no report, because a later change
 *  would not be from its run. */
export async function workspaceChangeReport(dataDir: string, workerId: string, dir: string, target: WorkspaceReportTarget): Promise<WorkerChangeReport> {
  try {
    const start = stateSchema.optional().parse(await readJson(await stateFile(dataDir, workerId, START_FILE)));
    if (!start) return { state: 'unavailable', reason: 'no workspace state was recorded: the worker started no session' };
    const recorded = target.generation === undefined ? undefined
      : endSchema.optional().parse(await readJson(await stateFile(dataDir, workerId, endFileName(target.generation))));
    const end = recorded && recorded.generation === target.generation ? recorded.state : undefined;
    if (!end && target.settled) return { state: 'unavailable', reason: 'no workspace state was recorded when the worker settled' };
    return await compareWorkspaceStates(dir, start, end ?? await captureWorkspaceState(dir));
  } catch (error) {
    return { state: 'unavailable', reason: (error instanceof Error ? error.message : String(error)).slice(0, 500) };
  }
}
