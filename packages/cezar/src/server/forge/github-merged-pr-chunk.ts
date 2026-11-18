import { z } from 'zod';
import type { ArchivePullRequestIdentity } from '@open-mercato/cezar-contract/runs';
import type { GraphqlRunner } from './github.ts';

/** A missing alias must not poison unrelated families. Discard partial data and requery only
 * unaffected aliases once; archive authority still comes from an error-free response. */
export async function mergedPullRequestChunk(runGraphql: GraphqlRunner, initial: ArchivePullRequestIdentity[]): Promise<unknown> {
  let chunk = initial;
  for (let attempt = 0; attempt < 2 && chunk.length; attempt++) {
    const query = `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { nameWithOwner ${chunk.map(pr => `pr${pr.number}: pullRequest(number: ${pr.number}) { number url state mergedAt }`).join(' ')} } }`;
    let response: unknown;
    let failure: unknown;
    try {
      response = JSON.parse(await runGraphql(query, { owner: chunk[0]!.owner, name: chunk[0]!.repo }));
    } catch (error) {
      // gh exits 1 on GraphQL errors, with the structured envelope on stdout. Neither stderr
      // nor timeout/abort output is evidence that one particular alias was missing.
      const rejected = z.object({ code: z.literal(1), stdout: z.string() }).safeParse(error);
      if (!rejected.success) throw error;
      try { response = JSON.parse(rejected.data.stdout); } catch { throw error; }
      failure = error;
    }
    const partial = z.object({
      errors: z.array(z.object({ type: z.literal('NOT_FOUND'), path: z.tuple([z.literal('repository'), z.string()]) })).nonempty(),
      data: z.object({ repository: z.object({ nameWithOwner: z.string() }) }),
    }).safeParse(response);
    const aliases = new Set(chunk.map(pr => `pr${pr.number}`));
    if (attempt === 0 && partial.success &&
      partial.data.data.repository.nameWithOwner.toLowerCase() === `${chunk[0]!.owner}/${chunk[0]!.repo}`.toLowerCase() &&
      partial.data.errors.every(error => aliases.has(error.path[1]))) {
      const missing = new Set(partial.data.errors.map(error => error.path[1]));
      chunk = chunk.filter(pr => !missing.has(`pr${pr.number}`));
      continue;
    }
    if (failure) throw failure;
    return response;
  }
  return undefined;
}
