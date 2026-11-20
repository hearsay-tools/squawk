import type { QueryClient } from '@tanstack/react-query'
import type { RunnersResponse } from '@open-mercato/cezar-api-client/contract/runners'

import { runnersQueryKey } from '@/api/runners'

/** `GET /api/v1/runners` as the server answers it with today's built-in runners, in display order. */
export const RUNNERS_RESPONSE: RunnersResponse = {
  runners: [
    { id: 'claude', displayName: 'Claude Code', modelListName: 'Claude', modelIdScope: 'own' },
    { id: 'codex', displayName: 'Codex', modelListName: 'Codex', modelIdScope: 'own' },
    { id: 'opencode', displayName: 'OpenCode', modelListName: 'OpenCode', modelIdScope: 'provider-spanning' },
    { id: 'pi', displayName: 'pi', modelListName: 'Pi', modelIdScope: 'provider-spanning' },
    { id: 'omp', displayName: 'OMP', modelListName: 'OMP', modelIdScope: 'provider-spanning' },
  ],
}

/** The fixture's runner ids, in display order. */
export const RUNNER_IDS: readonly string[] = RUNNERS_RESPONSE.runners.map((entry) => entry.id)

/** The URL the cockpit reads the runners from. */
export const RUNNERS_PATH = '/api/v1/runners'

/** Put the fixture in `queryClient`'s cache, as if the runners query had answered. Returns the
 *  client, so a render can seed it inline. */
export function seedRunners<Client extends QueryClient>(queryClient: Client, runners: RunnersResponse = RUNNERS_RESPONSE): Client {
  queryClient.setQueryData(runnersQueryKey, runners)
  return queryClient
}
