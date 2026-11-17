import { z } from 'zod';

// ---- old skill record shape (saved data) ------------------------------------------------

/** The old skill record shape, retained for saved-data readers. Runtime lists use runner-skills.ts. */
export const skillSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  body: z.string(),
  path: z.string(),
  /** `builtin`: shipped by Squawk itself and listed last (#774), so a repo skill of the same name wins. */
  source: z.enum(['ai', 'cezar', 'agents', 'global', 'team', 'builtin']),
  /** Team skills only: where the definition lives in its skills repo. */
  team: z
    .object({
      repo: z.string(),
      ref: z.string(),
      path: z.string(),
      /** True for the `SKILL.md` convention — a whole directory (references/…). */
      dir: z.boolean(),
      /**
       * The exact commit `ref` resolved to when the skill was read (#428).
       *
       * The hand-written DTO omitted this field entirely — it was NARROWER than the route,
       * which has served it since #428.
       */
      commit: z.string().optional(),
    })
    .optional(),
});
export type Skill = z.infer<typeof skillSchema>;
