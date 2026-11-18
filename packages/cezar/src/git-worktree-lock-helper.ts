import * as fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { runGit, type RunGitError } from './git-command.ts';

/** What a claim says about its owner, so a waiter that times out can name who holds the lock. */
export type MutationLabel = { operation: string; owner?: string };
type Claim = { pid: number; ticket: number; gitRunning: boolean; operation?: string; owner?: string };
/** The claim a timed-out waiter names: the one whose turn it is. */
export type MutationHolder = { pid: number; operation?: string; owner?: string };

/** One IPC message the keeper accepts over its channel. */
type KeeperMessage = { kind: string; id: number; cwd: string; args: string[]; timeout?: number; input?: string };
type CommandResult = { ok: boolean; stdout: string; stderr: string; timedOut?: true; childrenRunning?: true };

/** Run one queued Git command; without input git sees an empty stdin, exactly as before. */
async function runGitCommand(message: KeeperMessage): Promise<CommandResult> {
  const result = await runGit(message.args, { cwd: message.cwd, maxBuffer: 32 * 1024 * 1024, timeout: message.timeout, input: message.input ?? '' }).then(
    ({ stdout, stderr }): CommandResult => ({ ok: true, stdout, stderr }),
    (error: RunGitError): CommandResult => ({ ok: false, stdout: error.stdout ?? '', stderr: error.stderr || error.message || '',
      // A git killed at its bound says so: its stderr alone reads like any other failure.
      ...(error.killed && message.timeout ? { timedOut: true as const } : {}) }),
  );
  if (result.timedOut && await stopTimedOutChildren() !== 'stopped') {
    return { ...result, childrenRunning: true, stderr: `${result.stderr}\nGit child processes of the timed-out command may still be running`.trim() };
  }
  return result;
}

/** The PIDs in this keeper's process group other than itself; undefined where the host cannot list them. */
async function groupMembers(): Promise<number[] | undefined> {
  if (process.platform !== 'linux') return undefined;
  const members: number[] = [];
  // An unreadable /proc proves nothing: the caller reads undefined as unknown, never as exited.
  const entries = await fs.readdir('/proc').catch(() => undefined);
  if (!entries) return undefined;
  for (const entry of entries) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
    const stat = await fs.readFile(`/proc/${entry}/stat`, 'utf8').catch(() => '');
    // Fields after the parenthesised command name: state, ppid, pgrp.
    const pgrp = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2]);
    if (pgrp === process.pid) members.push(Number(entry));
  }
  return members;
}

/**
 * A timed-out git is killed alone; a child it started (the checkout of `worktree add`) can keep
 * writing. Every Git child is in this keeper's process group (ADR 0003), and the keeper runs one
 * command at a time, so the group's other members are that command's. Stop them before the caller
 * sees the failure: `running` when some remain after 10 s, `unknown` where the host cannot list them.
 */
async function stopTimedOutChildren(): Promise<'stopped' | 'running' | 'unknown'> {
  // Windows has no process groups to signal or list: its children may still run.
  if (process.platform === 'win32') return 'unknown';
  // The keeper is in its own group too: it ignores this one signal until the wait ends.
  const ignore = () => undefined;
  process.on('SIGTERM', ignore);
  try {
    try { process.kill(-process.pid, 'SIGTERM'); } catch { /* no other member */ }
    for (let waited = 0; waited < 10_000; waited += 50) {
      const members = await groupMembers();
      if (!members) return 'unknown';
      if (!members.length) return 'stopped';
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return 'running';
  } finally { process.off('SIGTERM', ignore); }
}

export async function readMutationClaim(
  path: string, platform: NodeJS.Platform, probe: (pid: number) => void,
): Promise<Claim | undefined> {
  let value: Claim;
  try { value = JSON.parse(await fs.readFile(path, 'utf8')) as Claim; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  if (!Number.isSafeInteger(value.pid) || value.pid <= 0 || !Number.isSafeInteger(value.ticket) || value.ticket < 0) throw new Error('invalid worktree mutation claim');
  // POSIX group lifetime survives the death of its keeper/leader: Git and
  // its children inherit this group. Only ESRCH proves EVERY member gone.
  // Do not replace this kernel probe with a PID/ps snapshot (forks can race it).
  if (platform === 'win32') {
    try { probe(value.pid); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
        // Re-read AFTER death is established. The first idle snapshot may
        // predate a last command's busy publication and spawn. The unique
        // filename cannot now be updated by its dead owner or a new keeper.
        let final: Claim;
        try { final = JSON.parse(await fs.readFile(path, 'utf8')) as Claim; }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
        if (final && final.pid === value.pid && Number.isSafeInteger(final.ticket) && final.ticket >= 0 && final.gitRunning === false) {
          await fs.unlink(path).catch(() => undefined);
          return;
        }
        throw new Error('cannot prove a dead worktree keeper has no surviving Git children on Windows');
      }
    }
    return value;
  }
  try { probe(-value.pid); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
      // Each claimant owns a unique filename, so recovery cannot unlink a new
      // owner's lock (the ABA race of unlinking/replacing one shared lockfile).
      await fs.unlink(path).catch(() => undefined);
      return;
    }
    // EPERM/unknown means possibly alive: never steal that claim.
  }
  return value;
}

/**
 * Lamport bakery: choose a ticket above every visible ticket.
 * Atomic rename keeps readers from observing partial JSON.
 */
async function selectTicket(
  directory: string, name: string, read: (entry: string) => Promise<Claim | undefined>,
): Promise<number> {
  let ticket = 1;
  for (const entry of await fs.readdir(directory)) {
    if (!entry.endsWith('.json') || entry === name) continue;
    const claim = await read(entry);
    if (claim) ticket = Math.max(ticket, claim.ticket + 1);
  }
  return ticket;
}

/** A peer holds the turn while it is still choosing or holds a smaller (ticket, name) pair. */
function hasPriority(claim: Claim, ticket: number, entry: string, name: string): boolean {
  return claim.ticket === 0 || claim.ticket < ticket || (claim.ticket === ticket && entry < name);
}

/** The blocker whose turn it is: the smallest (ticket, name) pair; a peer still choosing (ticket 0) only when no other blocks. */
function turnHolder(blockers: [{ claim: Claim; entry: string }, ...Array<{ claim: Claim; entry: string }>]): MutationHolder {
  const order = (value: { claim: Claim }) => value.claim.ticket === 0 ? Number.MAX_SAFE_INTEGER : value.claim.ticket;
  const first = blockers.reduce((best, next) => order(next) - order(best) < 0 || (order(next) === order(best) && next.entry < best.entry) ? next : best);
  const { pid, operation, owner } = first.claim;
  return { pid, ...(typeof operation === 'string' ? { operation } : {}), ...(typeof owner === 'string' ? { owner } : {}) };
}

/** Wait for choosing peers and smaller (ticket, name) pairs, or give up naming the claim whose turn it is. */
async function waitForTurn(
  directory: string, name: string, ticket: number,
  options: { read: (entry: string) => Promise<Claim | undefined>; isStopping: () => boolean; deadline: number; wait: () => Promise<void> },
): Promise<{ turn: 'ready' | 'stopped' } | { turn: 'timeout'; holder?: MutationHolder }> {
  for (;;) {
    if (options.isStopping()) return { turn: 'stopped' };
    const late = Date.now() >= options.deadline;
    const blockers: Array<{ claim: Claim; entry: string }> = [];
    for (const entry of await fs.readdir(directory)) {
      if (!entry.endsWith('.json') || entry === name) continue;
      const claim = await options.read(entry);
      if (claim && hasPriority(claim, ticket, entry, name)) blockers.push({ claim, entry });
      // Before the deadline one blocker is enough; past it, read them all to name the right one.
      if (blockers.length && !late) break;
    }
    const [head, ...rest] = blockers;
    if (!head) return { turn: 'ready' };
    if (late) return { turn: 'timeout', holder: turnHolder([head, ...rest]) };
    await options.wait();
  }
}

/** The claims queued ahead of a ticket: those that can block it, a peer still choosing included.
 * A peer that published a higher ticket before this count is behind it and does not count. */
async function claimsAhead(directory: string, name: string, ticket: number, read: (entry: string) => Promise<Claim | undefined>): Promise<number> {
  let ahead = 0;
  for (const entry of await fs.readdir(directory)) {
    if (!entry.endsWith('.json') || entry === name) continue;
    const claim = await read(entry);
    if (claim && hasPriority(claim, ticket, entry, name)) ahead += 1;
  }
  return ahead;
}

/** The longest any wait may last, its queue share included. */
export const MAX_QUEUED_WAIT_MS = 600_000;

/** The wait budget for a claim with `ahead` claims queued before it: the base, plus `perClaimMs` for each, at most 10 min. */
export function queuedWaitBudget(waitMs: number, perClaimMs: number, ahead: number): number {
  return Math.max(waitMs, Math.min(MAX_QUEUED_WAIT_MS, waitMs + perClaimMs * ahead));
}

/** The keeper's per-claim wait argument in ms: a whole number from 0 to 600 000, 0 when absent. */
export function keeperPerClaimBudget(value: string | undefined): number {
  const perClaimMs = Number(value ?? 0);
  if (!Number.isSafeInteger(perClaimMs) || perClaimMs < 0 || perClaimMs > MAX_QUEUED_WAIT_MS) throw new Error('invalid worktree mutation wait budget');
  return perClaimMs;
}

/** The keeper's label argument: JSON with a non-empty `operation` and an optional `owner`; none when absent. */
export function keeperLabel(value: string | undefined): MutationLabel | undefined {
  if (!value) return undefined;
  const parsed = JSON.parse(value) as Partial<MutationLabel>;
  if (typeof parsed.operation !== 'string' || !parsed.operation || (parsed.owner !== undefined && typeof parsed.owner !== 'string')) throw new Error('invalid worktree mutation label');
  return { operation: parsed.operation.slice(0, 80), ...(parsed.owner ? { owner: parsed.owner.slice(0, 80) } : {}) };
}

/** The keeper's wait budget argument in ms: a whole number from 0 to 120 000, 120 000 when absent. */
export function keeperWaitBudget(value: string | undefined): number {
  const waitMs = Number(value ?? 120_000);
  if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 120_000) throw new Error('invalid worktree mutation wait budget');
  return waitMs;
}

/** Short-lived IPC keeper; launched only by git-worktree-lock.ts. */
async function keepWorktreeLock(): Promise<void> {
  const { join } = await import('node:path');
  const { randomUUID } = await import('node:crypto');
  const directory = process.argv[2]!;
  const name = `${process.pid}-${randomUUID()}.json`;
  const path = join(directory, name);
  const temporary = `${path}.tmp`;
  const wait = () => new Promise<void>(resolve => setTimeout(resolve, 25));
  let stopping = !process.connected;
  let keepClaim = false;
  let stop!: () => void;
  const stopped = new Promise<void>(resolve => { stop = resolve; });
  let commands = Promise.resolve();
  process.on('disconnect', () => { stopping = true; stop(); });
  const send = (message: unknown) => { if (process.connected) process.send!(message, () => undefined); };
  const label = keeperLabel(process.argv[5]);
  const write = async (ticket: number, gitRunning = false) => {
    await fs.writeFile(temporary, JSON.stringify({ pid: process.pid, ticket, gitRunning, ...label }), { mode: 0o600 });
    await fs.rename(temporary, path);
  };
  const read = (entry: string) => readMutationClaim(join(directory, entry), process.platform, pid => { process.kill(pid, 0); });

  try {
    await fs.mkdir(directory, { recursive: true });
    // Lamport bakery: publish "choosing" atomically, then choose a ticket above
    // every visible ticket. Atomic rename keeps readers from observing partial JSON.
    await write(0);
    const ticket = await selectTicket(directory, name, read);
    await write(ticket);
    const budget = queuedWaitBudget(keeperWaitBudget(process.argv[3]), keeperPerClaimBudget(process.argv[4]), await claimsAhead(directory, name, ticket, read));
    const turn = await waitForTurn(directory, name, ticket, { read, isStopping: () => stopping, deadline: Date.now() + budget, wait });
    if (turn.turn === 'timeout') send({ kind: 'error', code: 'lock_timeout', error: 'timed out waiting for worktree mutation lock', ...(turn.holder ? { holder: turn.holder } : {}) });
    if (turn.turn !== 'ready') return; // finally withdraws ONLY this queued claim; no mutation was admitted
    process.on('message', (message: KeeperMessage) => {
      if (stopping || message.kind !== 'git') return;
      commands = commands.then(async () => {
        // A command whose children may still write admits no further mutation.
        if (keepClaim) throw new Error('Git child processes of a timed-out command may still be running');
        await write(ticket, true);
        const result = await runGitCommand(message);
        await write(ticket);
        // Their claim outlives this keeper: the group probe frees it once every member is gone
        // (readMutationClaim). Windows has no such probe; a claim kept there could never be freed, so
        // it is released as before and only the rollback and retry are skipped.
        if (result.childrenRunning && process.platform !== 'win32') keepClaim = true;
        send({ kind: 'result', id: message.id, result });
      }).catch(error => {
        send({ kind: 'error', error: `worktree mutation command failed: ${String(error)}` });
        stopping = true;
        stop();
      });
    });
    send({ kind: 'ready' });
    await stopped;
  } catch (error) {
    send({ kind: 'error', error: `worktree mutation coordination failed: ${String(error)}` });
  } finally {
    await commands;
    if (!keepClaim) await fs.unlink(path).catch(() => undefined);
    await fs.unlink(temporary).catch(() => undefined);
    if (process.connected) process.disconnect();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await keepWorktreeLock();
