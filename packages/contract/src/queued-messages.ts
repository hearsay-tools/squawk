import { z } from 'zod';

/** One prompt message stacked onto a run while it waits for a free agent slot (open-mercato/cezar#472). */
export const queuedMessageSchema = z.object({
  replayAfterOpen: z.literal(true).optional(), // NativeSkillInputQueue sets; launch hydration excludes; QueuedInput replays after open.
  id: z.string(),
  text: z.string(),
  /** `/api/v1/runs/:id/images/…` URLs — attachments are persisted, never inlined. Images and
   *  files share this one list; read `isImageAttachmentName` on the file name to tell them apart. */
  images: z.array(z.string()).optional(),
  createdAt: z.string(),
});
export type QueuedMessage = z.infer<typeof queuedMessageSchema>;

/** Optional for legacy records; only explicit human origin can acknowledge a delegated ask. */
export const continuationMessageSchema = queuedMessageSchema.extend({
  origin: z.enum(['human', 'lifecycle']).optional(),
  /** An attributed parent message used as the opening prompt, never a human answer. */
  agentInputId: z.uuid().optional(),
  /** The run's task when this Continue was accepted. A queued Continue repeats the task only
   *  when the human edited it while waiting (hearsay-tools/squawk#3882). */
  task: z.string().optional(),
  /** Captured before clearing the run error. Keep generated context separate from human
   * text so repeated restart recovery never accumulates diagnostic prefixes. */
  resumeContext: z.object({
    failure: z.object({ stepId: z.string().optional(), error: z.string() }).optional(),
    restarted: z.literal(true).optional(),
  }).optional(),
});
