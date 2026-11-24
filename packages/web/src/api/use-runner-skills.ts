import { useQuery } from '@tanstack/react-query'
import type { Runner } from '@open-mercato/cezar-api-client'
import { queryScope } from '@open-mercato/cezar-api-client/utils/project-scope'
import { getRunnerSkills } from './client'
import { queryKeys, useConfig, useHealth } from './queries'
import { planRunner, runnerIds, useRunners } from './runners'

export function useRunnerSkills(runner?: Runner, account?: string | null, enabled = true) {
  const config = useConfig()
  const health = useHealth()
  const registered = useRunners()
  // A caller that names the runner already resolved it. Only the stored default needs the
  // runners list, and that request waits until the list answers so an unknown id is not sent.
  const storedDefault = runner === undefined ? config.data?.defaultRunner : undefined
  const resolvedDefault = planRunner(storedDefault, runnerIds(registered.data))
  const selected = runner ?? resolvedDefault ?? storedDefault ?? 'claude'
  const runnersReady = runner !== undefined || registered.isSuccess
  // Hosted routes allow the project's account selection, but no explicit account.
  const selectedAccount = health.data?.capabilities?.localHandoff === false ? null : account
  const scope = queryScope()
  const query = useQuery({
    queryKey: queryKeys.runnerSkills(selected, selectedAccount),
    queryFn: ({ signal }) => getRunnerSkills(selected, selectedAccount, { signal, projectId: scope }),
    enabled: enabled && runnersReady && (runner !== undefined || !config.isPending) && (!account || !health.isPending),
    retry: false,
  })
  return { ...query, runner: selected, account: selectedAccount, data: query.data?.skills, list: query.data,
    unchecked: query.isError || !query.data || query.data.source === 'unavailable' }
}
