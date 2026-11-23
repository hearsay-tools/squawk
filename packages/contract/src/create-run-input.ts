import { z } from 'zod';
import { isAttachmentMediaType } from './attachments.ts';
import { runnerSchema } from './runner.ts';
import { completionControlsShape, taskAccessShape } from './task-options.ts';
import { workflowStepDefSchema } from './workflows.ts';

export const attachmentInputSchema = z.object({
  mediaType: z.string().refine(isAttachmentMediaType, {
    message: 'unsupported attachment type — images, plain text, markdown and PDF only',
  }),
  data: z.string().min(1).max(7_000_000),
});
export type AttachmentInput = z.input<typeof attachmentInputSchema>;

/** @deprecated Attachments are no longer images only — use `attachmentInputSchema`. Kept because
 *  the `images` key it validates is the wire contract and did not change name. */
export const imageInputSchema = attachmentInputSchema;
export type ImageInput = AttachmentInput;

/**
 * The KEYS of `POST /runs`' body, before the XOR refinement that `createRunInputSchema` adds.
 *
 * Split into a leaf module (hearsay-tools/squawk#3935) so `./automations.ts` builds an
 * automation's task on top of this shape without loading `./runs.ts`, and because zod refuses
 * `.omit()` on a schema that carries refinements. Validate with `createRunInputSchema` in
 * `./runs.ts` — this half accepts a body naming both `workflow` and `steps`, which the server does
 * not.
 */
export const createRunInputBaseSchema = z
  .object({
    workflow: z.string().min(1).optional(),
    /** An inline chain (spec 008 — an approved plan runs as an ad-hoc workflow, never written to
     *  a file). The catalog's own step shape, not a copy of it. */
    steps: z.array(workflowStepDefSchema).min(1).max(8).optional(),
    task: z.string().min(1).max(100_000, 'must be at most 100000 characters'),
    model: z.string().optional(),
    /** Reasoning-effort pin. Omit for the harness default; empty/`auto` stay implicit. */
    effort: z.string().max(32).optional(),
    runner: runnerSchema.optional(),
    /** Agent account for this task (spec 2026-07-29-agent-profiles). Omit to follow the
     *  project's own selection; an id that no longer exists is a 400, not a silent default. */
    agentProfile: z.string().max(64).optional(),
    /** false → run in the repo working tree instead of an isolated worktree (read-only skills).
     *  Omit for the default. */
    worktree: z.boolean().optional(),
    /** true → autonomous run: never parks at "waiting"; auto-continues until done. */
    autonomous: z.boolean().optional(),
    ...completionControlsShape, ...taskAccessShape,
    /** Per-run system-prompt override. Wins over the config default; whitespace-only is absent. */
    systemPrompt: z
      .string()
      .trim()
      .max(20_000, 'must be at most 20000 characters')
      .optional()
      .transform((s) => (s ? s : undefined)),
    /** Attachments pasted into the new-task form — screenshots and PDF/TXT/MD files; delivered
     *  with the first agent step. The key keeps its name: the wire contract widened in place
     *  rather than growing a second list. */
    images: z.array(attachmentInputSchema).max(4).optional(),
  });
