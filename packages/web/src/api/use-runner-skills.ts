import { useQuery } from '@tanstack/react-query'
import type { Runner } from '@open-mercato/cezar-api-client'
import { queryScope } from '@open-mercato/cezar-api-client/utils/project-scope'
import { getRunnerSkills } from './client'
import { queryKeys, useConfig, useHealth } from './queries'
import { useResolvedRunner } from './runners'

export function useRunnerSkills(runner?: Runner, account?: string | null, enabled = true) {
  const config = useConfig()
  const health = useHealth()
  // The caller's runner, or the stored default, can name a runner whose plugin did not load. The
  // request names the runner the server would run instead (hearsay-tools/squawk#4200).
  const stored = runner ?? config.data?.defaultRunner ?? 'claude'
  const { runner: selected, ready } = useResolvedRunner(stored)
  // Hosted routes allow the project's account selection, but no explicit account.
  const selectedAccount = health.data?.capabilities?.localHandoff === false ? null : account
  const scope = queryScope()
  const query = useQuery({
    queryKey: queryKeys.runnerSkills(selected, selectedAccount),
    queryFn: ({ signal }) => getRunnerSkills(selected, selectedAccount, { signal, projectId: scope }),
    enabled: enabled && ready && (runner !== undefined || !config.isPending) && (!account || !health.isPending),
    retry: false,
  })
  return { ...query, runner: selected, account: selectedAccount, data: query.data?.skills, list: query.data,
    unchecked: query.isError || !query.data || query.data.source === 'unavailable' }
}
