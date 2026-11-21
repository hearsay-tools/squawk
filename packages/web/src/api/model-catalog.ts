import { useQuery, useQueries, type QueryClient } from '@tanstack/react-query'
import type { Runner } from '@open-mercato/cezar-api-client'
import { getRunnerModels } from './model-catalog-client'
import { workspaceQueryKeys } from './queries'

/** Drop the cockpit's host model catalog so the next picker open rediscovers. Omit `runner` to bust every discovery runner (Providers "Check again"). */
export function invalidateRunnerModels(
  queryClient: QueryClient,
  runner?: string,
  refetchType: 'active' | 'none' = 'active',
) {
  return queryClient.invalidateQueries({
    queryKey: runner === undefined ? (['workspace', 'models'] as const) : workspaceQueryKeys.models(runner),
    refetchType,
  })
}

/**
 * One runner's host-discovered catalog, cached per runner (hearsay-tools/cezarion#794 — this used to be hard-wired to
 * Codex, which is why OpenCode had nothing but stale presets to show).
 *
 * Every runner discovers models. Failures retain the existing picker fallback;
 * callers read `data`/`isError` without backend-specific branches.
 *
 * `enabled` lets a caller that only MIGHT render the model pills (the thread's Continue — hooks
 * cannot be called conditionally) skip the fetch when it definitely won't.
 */
export function useRunnerModels(runner: Runner, enabled = true, profileId?: string | null) {
  return useQuery({ ...runnerModelsQuery(runner, profileId), enabled })
}

const runnerModelsQuery = (runner: string, profileId?: string | null) => ({
  queryKey: workspaceQueryKeys.models(runner, profileId),
  queryFn: ({ signal }: { signal: AbortSignal }) => getRunnerModels(runner, { signal }, profileId),
  staleTime: 5 * 60 * 1_000,
})

/**
 * Every listed runner's catalog at once, keyed by runner — for the screens that render a row PER
 * runner (the Settings default-model selects) rather than one for the runner the user picked.
 * One query per runner with its own cache entry, `enabled` state and error state; none until the
 * runners list answers.
 */
export function useRunnerModelCatalogs(
  runners: readonly string[],
  enabled = true,
): Record<string, ReturnType<typeof useRunnerModels>> {
  const results = useQueries({ queries: runners.map((runner) => ({ ...runnerModelsQuery(runner), enabled })) })
  return Object.fromEntries(runners.map((runner, index) => [runner, results[index] as (typeof results)[number]]))
}

