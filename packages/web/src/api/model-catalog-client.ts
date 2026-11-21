import { DEFAULT_AGENT_ACCOUNT_ID } from '@open-mercato/cezar-api-client/contract/agent-profiles'
import type { ModelDiscoveryRunner, RunnerModelCatalogResponse } from '@open-mercato/cezar-api-client'
import { cez, init, unwrap, type ReadOptions } from './client'

/** Host-local model catalog, separated by the optional selected account. */
export async function getRunnerModels(
  runner: ModelDiscoveryRunner,
  opts?: ReadOptions,
  profileId?: string | null,
): Promise<RunnerModelCatalogResponse> {
  return unwrap(await cez.api.v1.models.$get({ query: { runner, ...(profileId && profileId !== DEFAULT_AGENT_ACCOUNT_ID ? { profileId } : {}) } }, init(opts)), '/models')
}

