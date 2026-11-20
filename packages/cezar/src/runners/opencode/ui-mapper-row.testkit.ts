import { mapper } from '../../core/ui-mapper-row.testkit.ts';
import { createOpencodeUiState, mapOpencodeEvent, opencodeSessionStarted, opencodeTurnStarted } from './opencode-ui-mapper.ts';

/** The opencode runner's row of the UI mapper robustness test: its mapper and the state it holds at its first wire frame. */
export const uiMapperRow = mapper(
  () => opencodeTurnStarted(opencodeSessionStarted('ses_01J8ZE00MAIN', createOpencodeUiState()).state).state,
  mapOpencodeEvent,
);
