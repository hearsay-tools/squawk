import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ignoreTermPython, ignoreTermShell, ignoreTermSource, ownerGuardSource } from './stubborn-child.testkit.ts';

const started: ChildProcess[] = [];
afterEach(() => {
  for (const child of started.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
});

const posix = process.platform !== 'win32';
const python = posix && spawnSync('python3', ['-I', '-c', ''], { stdio: 'ignore' }).status === 0;

function start(command: string, args: string[]): ChildProcess {
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'] });
  started.push(child);
  return child;
}

/** The next line `child` prints. */
async function line(child: ChildProcess): Promise<string> {
  const [chunk] = await once(child.stdout!, 'data') as [Buffer];
  return String(chunk).trim();
}

/** A stand-in for the test runner, which the test can SIGKILL. */
async function owner(): Promise<ChildProcess> {
  const stand = start(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  await once(stand, 'spawn');
  return stand;
}

/**
 * The guarded child survives SIGTERM while its owner lives: it still answers a ping sent after
 * the signal, so the signal was handled before the answer. Once the owner is SIGKILLed, the
 * child ends by SIGKILL.
 */
async function proveGuard(build: (owner: number) => [string, string[]]) {
  const stand = await owner();
  const child = start(...build(stand.pid!));
  const exited = once(child, 'exit');
  expect(await line(child)).toBe('ready');
  child.kill('SIGTERM');
  child.stdin!.write('ping\n');
  expect(await line(child)).toBe('pong');
  expect(child.exitCode).toBe(null);
  stand.kill('SIGKILL');
  const [, signal] = await exited;
  expect(signal).toBe('SIGKILL');
}

// bound: two process starts, then the guard's one-second check after the owner is gone.
const BOUND_MS = 15_000;

describe.runIf(posix)('an owner-death guard (hearsay-tools/squawk#3941)', () => {
  it('ends a Node child once its owner is SIGKILLed, and the child ignores SIGTERM until then', async () => {
    await proveGuard(pid => [process.execPath, ['-e',
      `${ignoreTermSource(pid)} process.stdout.write('ready\\n'); require('node:readline').createInterface({ input: process.stdin }).on('line', () => process.stdout.write('pong\\n'));`]]);
  }, BOUND_MS);

  it('ends a shell child the same way', async () => {
    await proveGuard(pid => ['sh', ['-c', `${ignoreTermShell(pid)} echo ready; while read -r line; do echo pong; done; sleep 60`]]);
  }, BOUND_MS);

  it.runIf(python)('ends a Python child the same way', async () => {
    await proveGuard(pid => ['python3', ['-I', '-c', `${ignoreTermPython(pid)}\nimport sys\nprint('ready', flush=True)\nfor _ in sys.stdin: print('pong', flush=True)`]]);
  }, BOUND_MS);

  it('ends a fixture that installs the guard in itself', async () => {
    const helper = JSON.stringify(new URL('./stubborn-child.testkit.ts', import.meta.url).href);
    await proveGuard(pid => [process.execPath, ['--input-type=module', '-e',
      `import { ignoreTermUntilOwnerExits } from ${helper}; import { createInterface } from 'node:readline'; ignoreTermUntilOwnerExits(${pid}); process.stdout.write('ready\\n'); createInterface({ input: process.stdin }).on('line', () => process.stdout.write('pong\\n'));`]]);
  }, BOUND_MS);

  it('never names pid 0 or 1, which would signal a whole group or init', () => {
    for (const pid of [0, 1, -5, Number.NaN, 2.5]) {
      expect(() => ignoreTermSource(pid)).toThrow(/is no pid/);
      expect(() => ignoreTermShell(pid)).toThrow(/is no pid/);
      expect(() => ignoreTermPython(pid)).toThrow(/is no pid/);
    }
  });
});

describe('the cockpit copy', () => {
  it('gives the same Node source as the service helper', async () => {
    // A test-only reach into packages/web: the cockpit imports nothing from the service, so it keeps a copy.
    const web = await import(pathToFileURL(new URL('../../web/src/test/stubborn-child.ts', import.meta.url).pathname).href) as typeof import('./stubborn-child.testkit.ts');
    expect(web.ignoreTermSource(4242)).toBe(ignoreTermSource(4242));
    expect(web.ownerGuardSource(4242)).toBe(ownerGuardSource(4242));
    expect(web.ignoreTermSource()).toBe(ignoreTermSource());
  });
});
