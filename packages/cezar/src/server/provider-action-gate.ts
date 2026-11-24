import { controlLocation } from '@open-mercato/cezar-contract/control-locations';
import type { ProviderId } from '../core/provider-auth.ts';
import type { ProviderStatusResponse } from '@open-mercato/cezar-contract/workspace';
import type { RunRecord } from '../runs/store.ts';
import { registeredRunnerId, registeredRunners, runnerDefinition, resolveRunnerId } from '../core/runner-registry.ts';
import { providersRequiredByWorkflow as requiredByWorkflow } from '@open-mercato/cezar-contract/workflows';
import { workerContinuationStep } from '@open-mercato/cezar-contract/run-predicates';
import type { WorkflowDef } from '@open-mercato/cezar-contract/workflows';

/** The registered runners an original workflow executes, in registration order. */
export function providersRequiredByWorkflow(workflow: WorkflowDef, fallback: ProviderId): ProviderId[] {
  // A preserved unknown default executes as the registered runner, so the gate checks that runner.
  return requiredByWorkflow(workflow, resolveRunnerId(fallback), registeredRunners().map(({ id }) => id)) as ProviderId[];
}

export function providerForExistingRun(
  run: RunRecord,
  override?: ProviderId,
): ProviderId {
  if (override) return override;
  return resolveRunnerId(workerContinuationStep(run)?.runner ?? run.runner);
}

/** The provider an untouched cancelled run continues on: a worker's first agent step, else the run's runner, else config default. */
export async function providerForUntouchedRun(
  run: RunRecord,
  defaultRunner: () => Promise<ProviderId>,
): Promise<ProviderId> {
  const stepRunner = workerContinuationStep(run, true)?.runner;
  if (stepRunner !== undefined) return resolveRunnerId(stepRunner);
  return resolveRunnerId(run.runner === undefined ? await defaultRunner() : run.runner);
}

/** Resolve the original, target, and required providers for `POST /runs/:id/continue`. */
export async function continueRunProviders(
  run: RunRecord,
  requestedRunner: string | undefined,
  untouched: boolean,
  defaultRunner: () => Promise<ProviderId>,
): Promise<{ original: ProviderId; target: ProviderId; required: ProviderId[] }> {
  const original = untouched
    ? await providerForUntouchedRun(run, defaultRunner)
    : providerForExistingRun(run);
  const target = requestedRunner === undefined ? original : registeredRunnerId(requestedRunner);
  const required = untouched ? providersRequiredByWorkflow(run.workflowDef!, target) : [target];
  return { original, target, required };
}

/**
 * The named (non-default) account a start will run on, per provider, and its probed sign-in state.
 * A provider absent here runs on its DEFAULT account, whose state is the provider-status row.
 */
export interface GateAccount {
  label: string;
  status: ProviderStatusResponse['providers'][number]['status'];
}

export function unavailableProviderMessage(
  required: readonly ProviderId[],
  response: ProviderStatusResponse,
  accounts: ReadonlyMap<ProviderId, GateAccount> = new Map(),
): string | null {
  for (const provider of required) {
    const row = response.providers.find(({ provider: id }) => id === provider);
    const name = () => runnerDefinition(provider).display.displayName;
    if (row?.enabled === false) {
      return `${name()} is disabled. Enable it in ${controlLocation('providers')}.`;
    }
    // A named account answers for itself: the provider row speaks for the default account only, so
    // a signed-out default must not refuse a start on another, connected account
    // (hearsay-tools/squawk#4116).
    // A standing runtime incident is authoritative for the whole provider, as before named accounts
    // were checked: it ends only through a retry or a matching native verification.
    const account = row?.authFailureId === undefined ? accounts.get(provider) : undefined;
    const status = account?.status ?? row?.status;
    if (status === 'connected') continue;
    if (account && status === 'disconnected') {
      return `${name()} account "${account.label}" is not signed in. Sign in in ${controlLocation('providers')}.`;
    }
    return `${name()} credentials are unavailable. Authorize it in ${controlLocation('providers')}.`;
  }
  return null;
}
