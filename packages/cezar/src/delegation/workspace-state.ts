/** The recorded state of a directory a worker shares with its host, and the report of what changed
 *  between two states. Reads only: `--no-optional-locks` keeps `git status` from refreshing the index. */
import { createHash } from 'node:crypto';
import { lstat, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { WORKER_CHANGED_PATHS_CAP, type WorkerChangeReport } from '@open-mercato/cezar-contract/delegation';
import { git } from '../git-command.ts';
import { entryExists } from './entry-exists.ts';
import { workerDataDirectory, writeWorkerDataFile } from './context.ts';

/** How many status entries one recorded state keeps; the hash covers the rest. */
export const STATE_ENTRY_CAP = 5_000;
const STATE_FILE_BYTES = 4 * 1024 * 1024;
const START_FILE = 'worker-workspace-start.json';
const END_FILE = 'worker-workspace-end.json';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

const stateSchema = z.object({
  head: z.string().min(1),
  /** The checked-out branch; null for a detached HEAD. */
  branch: z.string().nullable(),
  /** SHA-256 of `git ls-files -s -z`: what the index holds, not the bytes of its file. */
  index: z.string().length(64),
  /** SHA-256 of every status entry, also those past `STATE_ENTRY_CAP`. */
  status: z.string().length(64),
  /** `[path, status code and file fingerprint]`, sorted by path. */
  entries: z.array(z.tuple([z.string(), z.string()])).max(STATE_ENTRY_CAP),
  entriesTruncated: z.boolean(),
}).strict();
export type WorkspaceState = z.infer<typeof stateSchema>;

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

/** Size, modification time and mode: a second edit of a file that was already changed shows here. */
async function fingerprint(dir: string, path: string): Promise<string> {
  const entry = await lstat(join(dir, path)).catch(() => undefined);
  return entry ? `${entry.size}:${entry.mtimeMs}:${entry.mode}` : 'absent';
}

export async function captureWorkspaceState(dir: string): Promise<WorkspaceState> {
  const head = (await gitOutput(dir, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
  const branch = await git(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { timeout: 30_000 });
  const index = sha256(await gitOutput(dir, ['ls-files', '-s', '-z']));
  const parsed = parseStatus(await gitOutput(dir, ['status', '--porcelain=v1', '-z', '--untracked-files=all']))
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const entries: Array<[string, string]> = [];
  for (let offset = 0; offset < parsed.length; offset += 64) {
    entries.push(...await Promise.all(parsed.slice(offset, offset + 64)
      .map(async ([path, code]): Promise<[string, string]> => [path, `${code} ${await fingerprint(dir, path)}`])));
  }
  return {
    head, branch: branch.ok ? branch.stdout.trim() : null, index,
    status: sha256(entries.map(([path, value]) => `${path}\0${value}\0`).join('')),
    entries: entries.slice(0, STATE_ENTRY_CAP), entriesTruncated: entries.length > STATE_ENTRY_CAP,
  };
}

async function readState(path: string): Promise<WorkspaceState | undefined> {
  if (!await entryExists(path)) return undefined;
  if ((await stat(path)).size > STATE_FILE_BYTES) throw new Error('the recorded workspace state is too large');
  return stateSchema.parse(JSON.parse(await readFile(path, 'utf8')));
}

async function stateFile(dataDir: string, workerId: string, name: string): Promise<string> {
  return join(await workerDataDirectory(dataDir, workerId), name);
}

/** Record the directory's state for the worker's first session. Written once: a later launch or
 *  Continue keeps the first record. */
export async function recordWorkspaceStart(dataDir: string, workerId: string, dir: string): Promise<void> {
  const path = await stateFile(dataDir, workerId, START_FILE);
  if (await entryExists(path)) return;
  await writeWorkerDataFile(path, Buffer.from(JSON.stringify(await captureWorkspaceState(dir))));
}

/** A new session runs: the last settlement's state is no longer the end. */
export async function clearWorkspaceEnd(dataDir: string, workerId: string): Promise<void> {
  await rm(await stateFile(dataDir, workerId, END_FILE), { force: true });
}

/** Record the directory's state when the worker's execution ended. A failed read leaves no end
 *  record, so the report compares with the directory as it is. */
export async function recordWorkspaceEnd(dataDir: string, workerId: string, dir: string): Promise<void> {
  const path = await stateFile(dataDir, workerId, END_FILE);
  await rm(path, { force: true });
  if (!await entryExists(await stateFile(dataDir, workerId, START_FILE))) return;
  await writeWorkerDataFile(path, Buffer.from(JSON.stringify(await captureWorkspaceState(dir))));
}

/** Paths whose status entry differs between two states, and paths two commits differ in. */
async function changedPaths(dir: string, start: WorkspaceState, end: WorkspaceState): Promise<string[]> {
  const before = new Map(start.entries), after = new Map(end.entries);
  const paths = new Set<string>();
  for (const path of new Set([...before.keys(), ...after.keys()])) if (before.get(path) !== after.get(path)) paths.add(path);
  if (start.head !== end.head) {
    const committed = await git(dir, ['diff', '--name-only', '-z', '--no-renames', start.head, end.head, '--'], { timeout: 30_000 });
    if (committed.ok) for (const path of committed.stdout.split('\0')) if (path) paths.add(path);
  }
  return [...paths].sort();
}

export async function compareWorkspaceStates(dir: string, start: WorkspaceState, end: WorkspaceState): Promise<WorkerChangeReport> {
  const headMoved = start.head !== end.head, branchMoved = start.branch !== end.branch, indexMoved = start.index !== end.index;
  const statusMoved = start.status !== end.status;
  if (!headMoved && !branchMoved && !indexMoved && !statusMoved) return { state: 'unchanged' };
  const paths = await changedPaths(dir, start, end);
  return {
    state: 'changed', paths: paths.slice(0, WORKER_CHANGED_PATHS_CAP),
    truncated: paths.length > WORKER_CHANGED_PATHS_CAP || (statusMoved && (start.entriesTruncated || end.entriesTruncated)),
    headMoved, branchMoved, indexMoved,
  };
}

/** What changed in `dir` since the worker's first session started: up to its last settlement, or up
 *  to now while it runs. */
export async function workspaceChangeReport(dataDir: string, workerId: string, dir: string): Promise<WorkerChangeReport> {
  try {
    const start = await readState(await stateFile(dataDir, workerId, START_FILE));
    if (!start) return { state: 'unavailable', reason: 'no workspace state was recorded: the worker started no session' };
    const end = await readState(await stateFile(dataDir, workerId, END_FILE)) ?? await captureWorkspaceState(dir);
    return await compareWorkspaceStates(dir, start, end);
  } catch (error) {
    return { state: 'unavailable', reason: (error instanceof Error ? error.message : String(error)).slice(0, 500) };
  }
}
