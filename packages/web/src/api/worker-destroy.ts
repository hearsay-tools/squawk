import type { WorkerDestroyResult } from '@open-mercato/cezar-api-client'
import { queryScope } from '@open-mercato/cezar-api-client/utils/project-scope'

import { cez, runPath, unwrap } from './client'

/** A human's verified cleanup of one owned worker (hearsay-tools/squawk#816), freeing its capacity slot only when
 *  every resource is proven removed. An incomplete cleanup answers 409 and throws; the
 *  relationships refetch then shows what remains. Without `discardWork`, a cleanup that would
 *  delete uncommitted changes or unlanded commits refuses, and the error carries that `work`. */
export async function destroyWorker(id: string, discardWork = false): Promise<WorkerDestroyResult> {
  return unwrap(
    await cez.api.v1.p[':projectId'].runs[':id']['worker-destroy'].$post({
      param: { projectId: queryScope(), id: encodeURIComponent(id) },
      query: {},
      json: discardWork ? { discardWork: true } : {},
    }),
    runPath(id, '/worker-destroy'),
  )
}
