import { mapper } from '../../core/ui-mapper-row.testkit.ts';
import { createAntigravityUiState, mapAntigravityFrame } from './antigravity-ui-mapper.ts';
export const uiMapperRow = mapper(createAntigravityUiState, mapAntigravityFrame);
