import { mapper } from '../../core/ui-mapper-row.testkit.ts';
import { createOmpUiState, mapOmpRpcMessage, ompTurnStarted } from './omp-ui-mapper.ts';

/** The omp runner's row of the UI mapper robustness test: its mapper and the state it holds at its first wire frame. */
export const uiMapperRow = mapper(() => ompTurnStarted(createOmpUiState(), 'p').state, mapOmpRpcMessage);
