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

/** The registered runners, in display order. Empty until the runners query answers. */
export function runnerEntries(runners: RunnersResponse | undefined): RunnerEntry[] {
  return runners?.runners ?? []
}

/** The registered runners' ids, in display order. Empty until the runners query answers. */
export function runnerIds(runners: RunnersResponse | undefined): string[] {
  return runnerEntries(runners).map((entry) => entry.id)
}

/** The runner a stored id names for a registered-only request. A registered id stays. An unknown
 *  id maps to the first registered runner, as the server's `resolveRunnerId` maps it to the
 *  default. The stored id itself is not changed. Undefined stays undefined. */
export function planRunner<T extends string>(
  stored: T | undefined,
  registered: readonly T[],
): T | undefined {
  if (stored === undefined) return undefined
  if (registered.includes(stored)) return stored
  return registered[0]
}

/** A stored runner id resolved for a registered-only request (`/models`, `/runner-skills`).
 *  `ready` is false while the runners list is pending, so an unknown id is not sent. Once the list
 *  answers, `runner` is `planRunner`'s answer. When the list fails, the stored id is sent as it is:
 *  the cockpit cannot tell a registered id from an unknown one, and holding every request would
 *  leave the pickers empty. */
export function useResolvedRunner<T extends string>(stored: T): { runner: T; ready: boolean } {
  const registered = useRunners()
  const runner = registered.isSuccess
    ? planRunner(stored, runnerIds(registered.data) as T[]) ?? stored
    : stored
  return { runner, ready: !registered.isPending }
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

/** The runner's name in the runner picker; the id itself when the runners list does not name it. */
export function runnerPickerLabel(runners: RunnersResponse | undefined, id: string): string {
  return runnerEntry(runners, id)?.pickerLabel ?? id
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
