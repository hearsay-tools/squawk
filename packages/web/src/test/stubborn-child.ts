/**
 * The cockpit's copy of the Node form of `packages/cezar/src/stubborn-child.testkit.ts`
 * (hearsay-tools/squawk#3941): a test child that ignores SIGTERM also SIGKILLs itself once its
 * owner, the test process by default, is gone. The web package imports nothing from the service,
 * so it keeps this copy; `packages/cezar/src/stubborn-child.test.ts` checks that both give the same source.
 */

/** The owner pid as source text. Refuses 0, 1 and anything that is not a whole pid. */
function ownerPid(owner: number): string {
  if (!Number.isSafeInteger(owner) || owner <= 1) throw new Error(`owner ${owner} is no pid`)
  return String(owner)
}

/** Node statements that SIGKILL this process once `owner` is gone. The unref'd timer keeps nothing alive. */
export function ownerGuardSource(owner: number = process.pid): string {
  return `setInterval(() => { try { process.kill(${ownerPid(owner)}, 0); } catch { process.kill(process.pid, 'SIGKILL'); } }, 1000).unref();`
}

/** Node statements that ignore SIGTERM and die with `owner`. */
export function ignoreTermSource(owner: number = process.pid): string {
  return `process.on('SIGTERM', () => {}); ${ownerGuardSource(owner)}`
}
