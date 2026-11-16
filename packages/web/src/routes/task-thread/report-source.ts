import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { queryScope } from '@open-mercato/cezar-api-client/utils/project-scope'

import { ApiError, getArtifactMetadata, getRunRelationships } from '@/api/client'

/** Metadata probes reuse the cards' cache. A missing publication is not a transport failure.
 * The shared request fetches with its own signal: a lookup cancelled mid-request must not abort
 * the request that the cards and the next lookup join. */
async function ownsReport(client: QueryClient, scope: string, runId: string, artifactId: string): Promise<boolean> {
  try {
    await client.fetchQuery({ queryKey: [scope, 'runs', 'artifact-metadata', runId, artifactId],
      queryFn: ({ signal }) => getArtifactMetadata(runId, artifactId, { signal }), retry: false })
    return true
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return false
    throw error
  }
}

/** Selection survives unloaded or virtualized messages. No transcript is needed to find ownership. */
export async function resolveReportSource(client: QueryClient, scope: string, runId: string, artifactId: string, signal: AbortSignal, knownSource?: string): Promise<string> {
  if (await ownsReport(client, scope, runId, artifactId)) return runId
  signal.throwIfAborted()
  const relationships = await client.fetchQuery({ queryKey: [scope, 'runs', 'relationships', runId],
    queryFn: ({ signal: own }) => getRunRelationships(runId, { signal: own }), retry: false })
  const candidates = new Set(relationships.workers.map(worker => worker.workerId))
  // A same-project publication can also be linked from another ordinary conversation.
  if (knownSource) candidates.add(knownSource)
  candidates.delete(runId)
  for (const candidate of candidates) {
    if (signal.aborted) throw signal.reason
    if (await ownsReport(client, scope, candidate, artifactId)) return candidate
  }
  throw new ApiError(404, 'Report missing or deleted')
}

export function useReportSource(runId: string | undefined, artifactId: string | undefined, knownSource?: string) {
  const client = useQueryClient()
  const scope = queryScope()
  return useQuery({ queryKey: [scope, 'runs', 'report-source', runId, artifactId, knownSource],
    queryFn: ({ signal }) => resolveReportSource(client, scope, runId!, artifactId!, signal, knownSource),
    enabled: Boolean(runId && artifactId), retry: false })
}
