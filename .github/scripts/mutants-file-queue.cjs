'use strict';
// One whole-file measurement at a time per user and host (hearsay-tools/squawk#3942). Parallel
// runs on one host compete for the CPU until Stryker's initial test run times out. The queue is in
// the per-user cache, not TMPDIR: each Squawk task has its own TMPDIR.
//
// Lamport's bakery on files: a run marks itself as choosing, takes a ticket one above the highest
// live ticket, and runs when no live run is choosing and no live ticket sorts before its own. Each
// file holds one process's PID, so a waiter removes only the files of dead processes and never a
// live run's file; a killed run needs no recovery step. Stryker runs in its own process group, which
// outlives a killed parent: a ticket also names those groups, and stays while any of them lives.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');

const QUEUE_DIR = path.join(os.homedir(), '.cache/cez/mutants/queue');
const POLL_MS = 5_000;
const ENTRY = /^(c|t)-(?:(\d{12})-)?(\d{10})\.json$/;

/** A process that exists, including one owned by another user (EPERM). A negative id names a process group. */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

const pad = (n, width) => String(n).padStart(width, '0');

/** Publish a complete JSON file: rename makes it visible in one step. */
function publish(io, dir, name, entry) {
  const temp = path.join(dir, `.${name}.tmp`);
  io.writeFileSync(temp, JSON.stringify(entry));
  io.renameSync(temp, path.join(dir, name));
}

/** Live choosing marks and tickets in queue order, after removing the files of dead processes. */
function entries(dir, io, isAlive) {
  const live = [];
  for (const name of io.readdirSync(dir)) {
    const match = ENTRY.exec(name);
    if (!match) continue;
    const pid = Number(match[3]);
    let content = {};
    try {
      content = JSON.parse(io.readFileSync(path.join(dir, name), 'utf8')) ?? {};
    } catch {}
    const groups = Array.isArray(content.groups) ? content.groups.filter(Number.isSafeInteger) : [];
    if (!isAlive(pid) && !groups.some(group => isAlive(-group))) {
      io.rmSync(path.join(dir, name), { force: true });
      continue;
    }
    live.push({ name, kind: match[1], ticket: Number(match[2] ?? 0), pid, file: content.file ?? '' });
  }
  return live.sort((a, b) => a.ticket - b.ticket || a.pid - b.pid);
}

/**
 * Wait for this run's turn and print the position when it changes. Returns `track(group)`, which
 * names a process group the run started, and `release()`, which leaves the queue.
 */
async function enterQueue({ file, signal, log, dir = QUEUE_DIR, pid = process.pid, io = fs, isAlive = alive, wait = ms => sleep(ms, undefined, { signal }) }) {
  io.mkdirSync(dir, { recursive: true });
  const choosing = `c-${pad(pid, 10)}.json`;
  let ticketName = null;
  const leave = () => {
    io.rmSync(path.join(dir, choosing), { force: true });
    if (ticketName) io.rmSync(path.join(dir, ticketName), { force: true });
  };
  try {
    publish(io, dir, choosing, { pid, file });
    const ticket = 1 + Math.max(0, ...entries(dir, io, isAlive).filter(e => e.kind === 't').map(e => e.ticket));
    ticketName = `t-${pad(ticket, 12)}-${pad(pid, 10)}.json`;
    publish(io, dir, ticketName, { pid, file });
    io.rmSync(path.join(dir, choosing), { force: true });
    let shown = 0;
    for (;;) {
      signal.throwIfAborted();
      const live = entries(dir, io, isAlive);
      const ahead = live.filter(e => e.kind === 't' && (e.ticket < ticket || (e.ticket === ticket && e.pid < pid)));
      if (ahead.length === 0 && !live.some(e => e.kind === 'c')) {
        if (shown) log('Queue: this run starts now');
        const own = ticketName;
        ticketName = null;
        const groups = [];
        return {
          track: group => { groups.push(group); publish(io, dir, own, { pid, file, groups }); },
          release: () => io.rmSync(path.join(dir, own), { force: true }),
        };
      }
      const position = ahead.length + 1;
      if (ahead.length && position !== shown) {
        shown = position;
        log(`Queue: position ${position}, ${ahead.length} ahead; running: ${ahead[0].file} (pid ${ahead[0].pid})`);
      }
      await wait(POLL_MS);
    }
  } catch (error) {
    leave();
    throw error;
  }
}

module.exports = { QUEUE_DIR, POLL_MS, enterQueue, alive };
