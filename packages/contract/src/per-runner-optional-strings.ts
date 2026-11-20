import { z } from 'zod';

/** Optional string values keyed by runner id, each independently optional. The server keeps only
 *  the keys of registered runners. */
export function perRunnerOptionalStrings() {
  return z.record(z.string(), z.string().optional());
}
