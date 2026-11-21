import type { BackendCheck } from '../core/backend-detect.ts';

/** How often a read may compare the environment stamp. The stamp is file metadata only. */
export const BACKEND_RECHECK_MS = 5_000;
/**
 * The longest a detection result is kept while its stamp holds. Most installs and upgrades change
 * the stamp; a version manager's shim (asdf, mise) does not, because the shim file stays the same
 * while the tool behind it changes. This ceiling bounds how long such a version string can lag.
 */
export const BACKEND_MAX_AGE_MS = 15 * 60_000;

export interface BackendChecks {
  /**
   * The last detected checks. Waits for the stamp comparison (file metadata), never for the
   * detection it may start: a cold read answers `[]` while the CLIs are still probed.
   */
  read(): Promise<BackendCheck[]>;
}

/**
 * Host CLI availability for `/health`, detected again only when it can have changed. Detection
 * starts one process per CLI, and each start forks the server process (hearsay-tools/squawk#3658).
 * So a read compares `stamp()`, at most every `BACKEND_RECHECK_MS`, and detects only when the
 * stamp changed, the last detection failed, or the result is `BACKEND_MAX_AGE_MS` old.
 */
export function createBackendChecks(options: {
  detect: () => Promise<BackendCheck[]>;
  stamp: () => Promise<string>;
  /** Called with new checks when a detection result differs from the last one. */
  onChange: (checks: BackendCheck[]) => void;
  now?: () => number;
}): BackendChecks {
  const now = options.now ?? Date.now;
  let checks: BackendCheck[] = [];
  let checkedAt = -Infinity;
  /** The last good detection: when it settled, and the stamp read before it started. */
  let detected: { stamp: Promise<string | undefined>; at: number } | undefined;
  let detecting: Promise<void> | undefined;
  let checking: Promise<void> | undefined;

  const detect = (stamp: Promise<string | undefined>) => {
    detecting = options.detect().then((next) => {
      detected = { stamp, at: now() };
      const changed = JSON.stringify(next) !== JSON.stringify(checks);
      checks = next;
      if (changed) options.onChange(next);
    }, () => { detected = undefined; })
      .finally(() => { checkedAt = now(); detecting = undefined; });
  };

  const unchanged = async (last: Promise<string | undefined>, current: Promise<string | undefined>) => {
    const [before, after] = await Promise.all([last, current]);
    return before !== undefined && before === after;
  };

  const check = async () => {
    // Read before detecting, so a change during detection gives a different stamp next time.
    const stamp = options.stamp().catch(() => undefined);
    if (detected && now() - detected.at < BACKEND_MAX_AGE_MS && await unchanged(detected.stamp, stamp)) {
      checkedAt = now();
      return;
    }
    detect(stamp);
  };

  return {
    async read() {
      if (!detecting && !checking && now() - checkedAt >= BACKEND_RECHECK_MS) {
        checking = check().finally(() => { checking = undefined; });
      }
      await checking;
      return checks;
    },
  };
}
