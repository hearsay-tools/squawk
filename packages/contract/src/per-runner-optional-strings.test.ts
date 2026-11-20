import { expectTypeOf, it } from 'vitest';
import type { AgentAccountSelection } from './agent-profiles.ts';
import type { RunnerModels, WorkspaceConfigResponse, WorkspaceUiState } from './workspace.ts';

/** Keyed by runner id, an open string (spec 2026-11-18-runner-definitions, decision 1). */
type OptionalRunnerStrings = Record<string, string | undefined>;

it('keys the four per-runner types by any runner id', () => {
  expectTypeOf<AgentAccountSelection>().toEqualTypeOf<OptionalRunnerStrings>();
  expectTypeOf<RunnerModels>().toEqualTypeOf<OptionalRunnerStrings>();
  expectTypeOf<WorkspaceConfigResponse['agentDefaults']['models']>()
    .toEqualTypeOf<OptionalRunnerStrings | undefined>();
  expectTypeOf<WorkspaceUiState['dismissedProviderAuthFailures']>()
    .toEqualTypeOf<OptionalRunnerStrings | undefined>();
});
