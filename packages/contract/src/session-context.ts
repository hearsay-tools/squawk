import { z } from 'zod';
import { utf8Bytes } from './utf8.ts';

/**
 * Settings → Session context (hearsay-tools/squawk#4308): read, preview and save the project's
 * `context.yaml` rules (docs/context-injection.md) through
 * `GET/PUT /session-context` and `POST /session-context/preview`.
 */

/** The largest `context.yaml` a launch reads, in UTF-8 bytes. The editor cannot save a larger one. */
export const SESSION_CONTEXT_FILE_MAX_BYTES = 256 * 1024;

const fileContentSchema = z
  .string()
  .refine((text) => utf8Bytes(text) <= SESSION_CONTEXT_FILE_MAX_BYTES, {
    error: `context.yaml must be at most ${SESSION_CONTEXT_FILE_MAX_BYTES} bytes`,
  });

/** `GET /session-context` and the `PUT` answer: the file as it is on disk, with its stale-write token. */
export const sessionContextFileSchema = z.object({
  /** Relative to the project root: `.ai/squawk/context.yaml` or `.ai/cezar/context.yaml`. */
  path: z.string(),
  exists: z.boolean(),
  content: z.string(),
  /** sha256 of the bytes, or null when the file does not exist. */
  version: z.string().nullable(),
  /** False when the file cannot be read as text, or lives in read-only fallback project data. */
  writable: z.boolean(),
  readOnlyReason: z.string().nullable(),
});
export type SessionContextFile = z.infer<typeof sessionContextFileSchema>;

/** `PUT /session-context`. `version` is the token the editor read; null creates the file. */
export const setSessionContextSchema = z.object({
  content: fileContentSchema,
  version: z.string().nullable(),
});
export type SetSessionContextInput = z.infer<typeof setSessionContextSchema>;

export const sessionContextRoleSchema = z.enum(['parent', 'worker']);
export type SessionContextRole = z.infer<typeof sessionContextRoleSchema>;

/** `POST /session-context/preview`: render a draft for one role. */
export const sessionContextPreviewRequestSchema = z.object({
  content: fileContentSchema,
  role: sessionContextRoleSchema,
});
export type SessionContextPreviewRequest = z.infer<typeof sessionContextPreviewRequestSchema>;

/** One thing the draft must fix before it saves. `line` and `rule` count from 1. */
export const sessionContextProblemSchema = z.object({
  line: z.number().nullable(),
  rule: z.number().nullable(),
  message: z.string(),
});
export type SessionContextProblem = z.infer<typeof sessionContextProblemSchema>;

export const sessionContextPreviewBlockSchema = z.object({
  id: z.string(),
  /** `built-in` for the handoff block; null when the file names no target for the entry. */
  target: z.enum(['built-in', 'parent', 'worker', 'both']).nullable(),
  status: z.enum(['applied', 'skipped', 'not-for-role']),
  bytes: z.number().nullable(),
  reason: z.string().nullable(),
  sources: z.array(z.string()),
  /** The rendered text, cut short for the preview; null when nothing rendered. */
  text: z.string().nullable(),
  truncated: z.boolean(),
});
export type SessionContextPreviewBlock = z.infer<typeof sessionContextPreviewBlockSchema>;

export const sessionContextPreviewSchema = z.object({
  problems: z.array(sessionContextProblemSchema),
  blocks: z.array(sessionContextPreviewBlockSchema),
  usedBytes: z.number(),
  limitBytes: z.number(),
});
export type SessionContextPreview = z.infer<typeof sessionContextPreviewSchema>;
