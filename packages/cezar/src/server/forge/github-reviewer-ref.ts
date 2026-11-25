import { z } from 'zod';

/** A requested reviewer, as either connection spells them. `login` covers `User` and `Bot`, `slug`
 *  covers `Team`; `reviewerKey` folds them into one comparable string. */
export const reviewerRefSchema = z
  .object({
    __typename: z.string().nullish(),
    login: z.string().nullish(),
    slug: z.string().nullish(),
  })
  .nullish();

/** One reviewer as a comparable key, or `null` when GitHub named nobody we can match on — which
 *  must never compare equal to another unnamed reviewer, hence `null` rather than a shared "". */
export function reviewerKey(ref: z.infer<typeof reviewerRefSchema>): string | null {
  const name = ref?.login ?? ref?.slug;
  return name ? `${ref?.__typename ?? '?'}:${name}` : null;
}
