import { z } from 'zod';

/**
 * A worker's settled outcome and the worker wait modes. The run events, the activity feed and the
 * wait list read them without the rest of `delegation.ts`, which re-exports them
 * (hearsay-tools/squawk#3245).
 */

export const workerOutcomeSchema = z.object({
  workerId: z.uuid(),
  status: z.enum(['review', 'done', 'failed', 'cancelled']),
  observedAt: z.iso.datetime(),
  summary: z.string().max(4_000).optional(),
  revision: z.number().int().nonnegative().optional(),
}).strict();
export type WorkerOutcome = z.infer<typeof workerOutcomeSchema>;

export const workerWaitModeSchema = z.enum(['one', 'any', 'all']);
