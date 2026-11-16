import { testHome } from '../home/test-home.testkit.ts';
import type { RunStore } from '../runs/store.ts';
import { apiRequest } from '../server/loopback-request.testkit.ts';
import { createApp } from '../server/server.ts';

/** One stored run event, as the permission cells read it. */
export type StoredEvent = Record<string, unknown>;

/** Answer a native permission request the way the cockpit does: through its API route. */
export function answerThroughRoute(repoRoot: string, store: RunStore, manager: Parameters<typeof createApp>[0]['manager'], runId: string,
  request: StoredEvent, optionId: string): Promise<Response> {
  return apiRequest(createApp({ home: testHome(), repoRoot, store, manager, version: 'test' }), `/api/v1/runs/${runId}/permissions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requestId: request.requestId, optionId }),
  });
}
