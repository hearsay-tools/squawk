import { mapper } from '../../core/ui-mapper-row.testkit.ts';
import { createCodexUiState, mapCodexNotification } from './codex-ui-mapper.ts';

/** The codex runner's row of the UI mapper robustness test: its mapper and the state it holds at its first wire frame. */
export const uiMapperRow = mapper(createCodexUiState, mapCodexNotification);
