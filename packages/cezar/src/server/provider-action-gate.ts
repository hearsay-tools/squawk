import { controlLocation } from '@open-mercato/cezar-contract/control-locations';
import type { ProviderId } from '../core/provider-auth.ts';
import type { ProviderStatusResponse } from '@open-mercato/cezar-contract/workspace';
import type { RunRecord } from '../runs/store.ts';
import { registeredRunners, runnerDefinition, resolveRunnerId } from '../core/runner-registry.ts';
import { providersRequiredByWorkflow as requiredByWorkflow } from '@open-mercato/cezar-contract/workflows';
import type { WorkflowDef } from '@open-mercato/cezar-contract/workflows';

/** The registered runners an original workflow executes, in registration order. */
export function providersRequiredByWorkflow(workflow: WorkflowDef, fallback: ProviderId): ProviderId[] {
  return requiredByWorkflow(workflow, fallback, registeredRunners().map(({ id }) => id)) as ProviderId[];
}

export function providerForExistingRun(
  run: RunRecord,
  override?: ProviderId,
): ProviderId {
  if (override) return override;
  return resolveRunnerId(run.runner);
}

export function unavailableProviderMessage(
  required: readonly ProviderId[],
  response: ProviderStatusResponse,
): string | null {
  for (const provider of required) {
    const row = response.providers.find(({ provider: id }) => id === provider);
    if (row?.enabled === false) {
      return `${runnerDefinition(provider).display.displayName} is disabled. Enable it in ${controlLocation('providers')}.`;
    }
    if (row?.status !== 'connected') {
      return `${runnerDefinition(provider).display.displayName} credentials are unavailable. Authorize it in ${controlLocation('providers')}.`;
    }
  }
  return null;
}
