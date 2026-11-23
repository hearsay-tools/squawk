import { z } from 'zod';

/**
 * Shared reference-status vocabulary for PRs and issues. Closed PR and completed issue remain
 * distinct outcomes. Server ranking describes the next action; merge conflict is independent.
 */
export const referenceStatusSchema = z.enum([
  'draft',
  'review-required',
  'changes-requested',
  'checks-pending',
  'checks-failing',
  'ready',
  'merged',
  'closed',
  'open',
  'completed',
  'not-planned',
]);
export type ReferenceStatus = z.infer<typeof referenceStatusSchema>;
