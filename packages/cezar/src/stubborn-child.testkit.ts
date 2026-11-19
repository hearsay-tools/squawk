/**
 * Test children that ignore SIGTERM, so a test can prove that a stop escalates to SIGKILL
 * (hearsay-tools/squawk#3941). A test kills such a child in its cleanup. When the test runner is
 * SIGKILLed first (a gate budget, a Squawk restart), no cleanup runs and nothing else would ever
 * SIGKILL the child. So each child built here also watches its owner, the test process by default:
 * about once a second it checks that the owner still exists, and SIGKILLs itself once it does not.
 * While the owner lives, the child still ignores SIGTERM.
 *
 * Every test builds a SIGTERM-ignoring child with one of these forms; `cez/stubborn-test-child`
 * refuses a bare one. `packages/web/src/test/stubborn-child.ts` is the cockpit's copy of the Node
 * form; `stubborn-child.test.ts` keeps the two in step.
 */

/** The owner pid as source text. Refuses 0, 1 and anything that is not a whole pid, so no guard can signal a group. */
function ownerPid(owner: number): string {
  if (!Number.isSafeInteger(owner) || owner <= 1) throw new Error(`owner ${owner} is no pid`);
  return String(owner);
}

/**
 * Node statements that SIGKILL this process once `owner` is gone. The timer is unref'd, so the
 * guard never keeps the process alive by itself. CommonJS and ESM both run it.
 */
export function ownerGuardSource(owner: number = process.pid): string {
  return `setInterval(() => { try { process.kill(${ownerPid(owner)}, 0); } catch { process.kill(process.pid, 'SIGKILL'); } }, 1000).unref();`;
}

/** Node statements that ignore SIGTERM and die with `owner`. Put them before the child's own code. */
export function ignoreTermSource(owner: number = process.pid): string {
  return `process.on('SIGTERM', () => {}); ${ownerGuardSource(owner)}`;
}

/**
 * Makes THIS process ignore SIGTERM and SIGKILL itself once `owner` is gone: the same guard as
 * {@link ignoreTermSource}, for a fixture script that is the stubborn child itself.
 */
export function ignoreTermUntilOwnerExits(owner: number): void {
  const pid = Number(ownerPid(owner));
  process.on('SIGTERM', () => {});
  setInterval(() => { try { process.kill(pid, 0); } catch { process.kill(process.pid, 'SIGKILL'); } }, 1000).unref();
}

/**
 * A POSIX sh command that runs in the background and SIGKILLs `target` once `owner` is gone. It
 * ends by itself within a second after `target` ends. It signals the one pid `target` names, never
 * a process group. `target` is a shell word, `$$` (this shell) by default; capture `$!` in a
 * variable first, because this command starts a job of its own. The guard catches SIGTERM with a
 * no-op, so a SIGTERM sweep of the group leaves it watching (hearsay-tools/squawk#3945 review). It
 * holds no quote character, so it keeps its meaning inside a quoted `sh -c '…'` script. Inside a `( … )` subshell `$$` is
 * still the outer shell, so a subshell that must die names its own captured pid instead.
 */
export function ownerGuardShell(target = '$$', owner: number = process.pid): string {
  const pid = ownerPid(owner);
  return `(trap : TERM; while kill -0 ${target} 2>/dev/null; do kill -0 ${pid} 2>/dev/null || { kill -KILL ${target} 2>/dev/null; exit; }; sleep 1; done) </dev/null >/dev/null 2>&1 &`;
}

/**
 * POSIX sh commands that make this shell ignore SIGTERM and die with `owner`. Its children inherit
 * the ignored TERM. Use it at the top of a `sh -c` script, not inside a `( … )` subshell.
 */
export function ignoreTermShell(owner: number = process.pid): string {
  return `trap '' TERM; ${ownerGuardShell('$$', owner)}`;
}

/**
 * Python 3 lines that ignore SIGTERM and SIGKILL the process once `owner` is gone. A daemon
 * thread runs the check, so it keeps running when the main thread exits.
 */
export function ignoreTermPython(owner: number = process.pid): string {
  return [
    'import os as _os, signal as _signal, threading as _threading, time as _time',
    '_signal.signal(_signal.SIGTERM, _signal.SIG_IGN)',
    'def _owner_guard():',
    '    while True:',
    '        _time.sleep(1)',
    '        try: _os.kill(' + ownerPid(owner) + ', 0)',
    '        except OSError: _os.kill(_os.getpid(), _signal.SIGKILL)',
    '_threading.Thread(target=_owner_guard, daemon=True).start()',
  ].join('\n');
}
