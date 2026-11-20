import { useQuery } from '@tanstack/react-query'
import {
  runnersResponseSchema,
  type RunnerEntry,
  type RunnerModelIdScope,
  type RunnersResponse,
} from '@open-mercato/cezar-api-client/contract/runners'

import { cez, init, unwrapValidated, type ReadOptions } from './client'

/**
 * The registered runners, from `GET /api/v1/runners` (spec 2026-11-18-runner-definitions,
 * decision 2): their ids in display order and the names the cockpit shows for them.
 *
 * Workspace-global: one registry serves every project, so the key carries no project scope. The
 * registry does not change while the server runs, so the answer never goes stale.
 */
export const runnersQueryKey = ['workspace', 'runners'] as const

export async function getRunners(opts?: ReadOptions): Promise<RunnersResponse> {
  return unwrapValidated(await cez.api.v1.runners.$get({}, init(opts)), '/runners', runnersResponseSchema)
}

const runnersQuery = {
  queryKey: runnersQueryKey,
  queryFn: ({ signal }: { signal: AbortSignal }) => getRunners({ signal }),
  staleTime: Infinity,
} as const

/** The registered runners. `data` is undefined until the server answers; runner pickers stay
 *  disabled until then. */
export function useRunners() {
  return useQuery(runnersQuery)
}

/** The registered runners' ids, in display order. Empty until the runners query answers. */
export function runnerIds(runners: RunnersResponse | undefined): string[] {
  return runners?.runners.map((entry) => entry.id) ?? []
}

/** The registered runner `id`, or undefined when no registered runner has that id. */
export function runnerEntry(runners: RunnersResponse | undefined, id: string): RunnerEntry | undefined {
  return runners?.runners.find((entry) => entry.id === id)
}

/** The runner's name on provider, account and conversation surfaces; the id itself when the
 *  runners list does not name it. */
export function runnerDisplayName(runners: RunnersResponse | undefined, id: string): string {
  return runnerEntry(runners, id)?.displayName ?? id
}

/** The runner's name in model discovery messages, or undefined when the runners list does not
 *  name it. */
export function runnerModelListName(runners: RunnersResponse | undefined, id: string): string | undefined {
  return runnerEntry(runners, id)?.modelListName
}

/** Which model ids the runner serves, or undefined when the runners list does not name it. */
export function runnerModelIdScope(
  runners: RunnersResponse | undefined,
  id: string,
): RunnerModelIdScope | undefined {
  return runnerEntry(runners, id)?.modelIdScope
}
