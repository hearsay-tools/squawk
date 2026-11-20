import { mapper } from '../../core/ui-mapper-row.testkit.ts';
import { createPiUiState, mapPiRpcMessage, piTurnStarted } from './pi-ui-mapper.ts';

/** The pi runner's row of the UI mapper robustness test: its mapper and the state it holds at its first wire frame. */
export const uiMapperRow = mapper(() => piTurnStarted(createPiUiState()).state, mapPiRpcMessage);
