/** Shared document/worker protocol; Zod stays owned by the contract workspace. */
export { LIVE_PROTOCOL, LIVE_WORKER_NAME, LEASE_MS, RENEW_MS, allowedLiveRead, liveDemandSchema, liveEntrySchema, ownerInputSchema, ownerOutputSchema, wireFrameSchema, runKey } from '@open-mercato/cezar-api-client/contract/live-coordination'
export type { LiveDemand, OwnerInput, OwnerOutput, LiveFrame } from '@open-mercato/cezar-api-client'

/** Connection attempts a shared live channel (the topic socket, a workspace or task stream) gets
 *  before it has ever carried a frame for the current demand. A proxy that cannot carry it (Basic
 *  Auth refuses a WebSocket upgrade, hearsay-tools/squawk#783) fails them all; the owner then tells
 *  every document `LIVE_CHANNEL_REFUSED`, and they stay on finite HTTP. */
export const LIVE_CONNECT_ATTEMPTS = 3
/** The `unavailable` reason for a channel that never connected within `LIVE_CONNECT_ATTEMPTS`. */
export const LIVE_CHANNEL_REFUSED = 'live channel refused'
