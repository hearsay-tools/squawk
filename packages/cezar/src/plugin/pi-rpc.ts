/**
 * Pi-family RPC wire and turn helpers (`@hearsay-tools/squawk/plugin/pi-rpc`). Kept separate
 * from `@hearsay-tools/squawk/plugin` so non-Pi runners do not load the Pi RPC transport helpers.
 * Unstable: it may change in any release until Squawk installs plugins from npm or git.
 */

export {
  contentText, isRecord, number, ompRpcError, ompSkillPrompt, parseRpcLine, piRpcError, string, toPiPrompt, truncate,
  waitForExit,
} from '../core/pi-rpc-wire.ts';
export {
  PiRpcInput, PiTextBlocks, adoptRpcSessionId, armEndWatchdog, dispatchPiTurnMessage, settlePiFamilyExit,
} from '../core/pi-rpc-turn.ts';
export type { PiEndWatchdog, PiSkillSubmission, PiTurnMessages } from '../core/pi-rpc-turn.ts';
