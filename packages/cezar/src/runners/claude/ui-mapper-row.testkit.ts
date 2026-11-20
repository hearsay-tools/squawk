import { mapper } from '../../core/ui-mapper-row.testkit.ts';
import { claudeTurnStarted, createClaudeUiState, mapClaudeMessage } from './claude-ui-mapper.ts';

/** The claude runner's row of the UI mapper robustness test: its mapper and the state it holds at its first wire frame. */
export const uiMapperRow = mapper(() => claudeTurnStarted(createClaudeUiState()).state, mapClaudeMessage);
