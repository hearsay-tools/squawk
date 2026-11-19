'use strict';
// One whole-file measurement at a time per user and host (hearsay-tools/squawk#3942). Parallel
// runs on one host compete for the CPU until Stryker's initial test run times out. The queue is in
// the per-user cache, not TMPDIR: each Squawk task has its own TMPDIR.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');

const QUEUE_DIR = path.join(os.homedir(), '.cache/cez/mutants/queue');
const LOCK = 'running.json';
const POLL_MS = 5_000;

/** A process that exists, including one owned by another user (EPERM). */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function readEntry(file, io) {
  try {
    const entry = JSON.parse(io.readFileSync(file, 'utf8'));
    return Number.isSafeInteger(entry?.pid) ? entry : null;
  } catch {
    return null;
  }
}

/** Publish a complete JSON file at `target`; link() fails with EEXIST when it already exists. */
function publish(io, dir, target, entry, exclusive) {
  const temp = path.join(dir, `.${process.pid}-${Math.random().toString(36).slice(2)}.tmp`);
  io.writeFileSync(temp, JSON.stringify(entry));
  try {
    if (exclusive) io.linkSync(temp, target);
    else io.renameSync(temp, target);
  } finally {
    io.rmSync(temp, { force: true });
  }
}

/** Waiting entries in queue order, after removing the entries of dead processes. */
function waiting(dir, io, isAlive) {
  const live = [];
  for (const name of io.readdirSync(dir).filter(n => n.startsWith('q-') && n.endsWith('.json')).sort()) {
    const entry = readEntry(path.join(dir, name), io);
    if (entry && !isAlive(entry.pid)) io.rmSync(path.join(dir, name), { force: true });
    else if (entry) live.push({ name, ...entry });
  }
  return live;
}

/** The running entry, or null. Only the first waiter removes a dead holder's lock. */
function holder(dir, io, isAlive, first) {
  const lock = path.join(dir, LOCK);
  const entry = readEntry(lock, io);
  if (entry && !isAlive(entry.pid) && first) {
    io.rmSync(lock, { force: true });
    return null;
  }
  return entry;
}

/**
 * Wait for this run's turn, print the position when it changes, and return a release function.
 * The lock file holds the running process; a process killed without cleanup leaves files whose PID
 * is dead, and the next waiter removes them.
 */
async function enterQueue({ file, signal, log, dir = QUEUE_DIR, pid = process.pid, now = Date.now, io = fs, isAlive = alive, wait = ms => sleep(ms, undefined, { signal }) }) {
  io.mkdirSync(dir, { recursive: true });
  const own = { pid, file, since: new Date(now()).toISOString() };
  const name = `q-${String(now()).padStart(15, '0')}-${String(pid).padStart(10, '0')}.json`;
  publish(io, dir, path.join(dir, name), own, false);
  const leave = () => io.rmSync(path.join(dir, name), { force: true });
  let shown = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const ahead = waiting(dir, io, isAlive).filter(e => e.name < name);
      const running = holder(dir, io, isAlive, ahead.length === 0);
      if (ahead.length === 0 && !running && take(io, dir, own)) {
        if (shown) log('Queue: this run starts now');
        leave();
        return () => release(io, dir, pid);
      }
      const position = ahead.length + (running ? 1 : 0);
      if (position !== shown) {
        shown = position;
        log(`Queue: position ${position + 1}, ${position} ahead; running: ${running ? `${running.file} (pid ${running.pid})` : 'none'}`);
      }
      await wait(POLL_MS);
    }
  } catch (error) {
    leave();
    throw error;
  }
}

function take(io, dir, own) {
  try {
    publish(io, dir, path.join(dir, LOCK), own, true);
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
}

/** Remove the lock only while this process still holds it. */
function release(io, dir, pid) {
  if (readEntry(path.join(dir, LOCK), io)?.pid === pid) io.rmSync(path.join(dir, LOCK), { force: true });
}

module.exports = { QUEUE_DIR, POLL_MS, enterQueue, alive };
