import { z } from 'zod';

/** Optional string values keyed by the runners, each independently optional. */
export function perRunnerOptionalStrings() {
  return z.object({
    claude: z.string().optional(),
    codex: z.string().optional(),
    opencode: z.string().optional(),
    pi: z.string().optional(),
    omp: z.string().optional(),
  });
}
