import { spawn } from 'node:child_process';
import { mkdtempSync, readlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { pidExists } from '../core/process-stat.ts';

/** A real same-user Linux holder: only enumeration may be scoped by callers. Its cwd is
 * unreadable, so it is no evidence of holding anything (hearsay-tools/cezarion#889). */
export function nonDumpableHolder(cwd: string) {
  return holder(cwd, false);
}

/** The same holder with a readable cwd. */
export function readableHolder(cwd: string) {
  return holder(cwd, true);
}

/** A readable holder that leads its own process group, so a worker scope can record it. */
export function groupHolder(cwd: string) {
  return holder(cwd, true, true);
}

async function holder(cwd: string, dumpable: boolean, detached = false) {
  const child = spawn('python3', ['-u', '-c', `
import ctypes, sys
${dumpable ? '' : 'assert ctypes.CDLL(None).prctl(4, 0, 0, 0, 0) == 0'}
print('ready', flush=True)
for line in sys.stdin:
    with open('holder-writes', 'a') as f: f.write(line)
    print('written', flush=True)
`], { cwd, stdio: ['pipe', 'pipe', 'pipe'], detached });
  const exited = once(child, 'exit');
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const expectLine = async (expected: string) => {
    const line = await lines.next();
    if (line.done || line.value !== expected) throw Error(`Expected holder acknowledgment: ${expected}`);
  };
  await Promise.race([expectLine('ready'), exited.then(() => { throw Error('Python holder fixture exited before readiness'); })]);
  // Assert the real kernel boundary; do not simulate EACCES.
  if (dumpable) readlinkSync(`/proc/${child.pid}/cwd`);
  else {
    try { readlinkSync(`/proc/${child.pid}/cwd`); throw Error('non-dumpable cwd unexpectedly readable'); }
    catch (error) { if (!['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) { child.kill(); await exited; throw error; } }
  }
  return { pid: child.pid!,
    /** Still running: nothing signalled it, even after its working directory was deleted. */
    get running() { return child.exitCode === null && child.signalCode === null; },
    async write() {
      const written = expectLine('written'); child.stdin.write('still writable\n'); await written;
    }, async close() { child.stdin.end(); await exited; } };
}

/** A group-leading holder that is not this process's child: its launcher exits at once, as a
 * crashed controller leaves its workers to init. A process this test spawned stays a zombie until
 * Node reaps it, which a synchronous wait in the code under test would never let happen. It runs
 * until `close` creates its stop file. */
export async function orphanedGroupHolder(cwd: string) {
  const stop = join(mkdtempSync(join(tmpdir(), 'cez-orphan-holder-')), 'stop');
  const launcher = spawn('python3', ['-u', '-c', `
import os, sys, time
if os.fork():
    os._exit(0)
os.setsid()
print('ready', os.getpid(), flush=True)
sys.stdout.close()
while not os.path.exists(sys.argv[1]):
    time.sleep(0.01)
`, stop], { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
  const line = await createInterface({ input: launcher.stdout })[Symbol.asyncIterator]().next();
  const [ready, printed] = String(line.value ?? '').split(' ');
  const pid = Number(printed);
  if (ready !== 'ready' || !Number.isSafeInteger(pid) || pid <= 1) throw Error('Expected holder acknowledgment: ready <pid>');
  return { pid,
    /** Still running: nothing signalled it. */
    get running() { return pidExists(pid); },
    async close() {
      writeFileSync(stop, '');
      // bound: the holder polls its stop file every 10 ms; this only ends a hang.
      const deadline = Date.now() + 10_000;
      while (pidExists(pid) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      if (pidExists(pid)) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
    } };
}
