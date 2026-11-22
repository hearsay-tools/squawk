import { useConfig, useProviderStatus } from '@/api/queries'
import { runnerIds, useRunners } from '@/api/runners'
import { providersRequiredByWorkflow } from '@open-mercato/cezar-api-client/contract/workflows'
import type { ApiRun, Runner } from '@open-mercato/cezar-api-client'
import { useRunnerAvailability } from '@/api/agent-accounts'
import { resolveRunner } from '@/routes/new-task-form'
import { isStoppedBeforeStarting } from './run-actions'

/** Every question the reason chain asks, in the priority order it asks them. */
interface ContinuationReasonInput {
  needsConfig: boolean
  configPending: boolean
  configError: boolean
  providersPending: boolean
  providersError: boolean
  canContinue: boolean
  untouched: boolean
  missing: string[]
}

/** Why this surface cannot continue yet: the task-settings checks first, then the provider
 *  checks, then the connect prompt. */
function continuationReason(input: ContinuationReasonInput): string | undefined {
  return input.needsConfig && input.configPending
    ? 'Checking task settings…'
    : input.needsConfig && input.configError
      ? 'Task settings could not be loaded.'
      : input.providersPending
        ? 'Checking agent providers…'
        : input.providersError
          ? 'Provider authentication could not be verified.'
          : input.canContinue
            ? undefined
            : input.untouched
              ? `Connect the required workflow providers (${input.missing.join(', ')}) to continue.`
              : 'Connect an agent provider to continue.'
}

/** The provider status and the runners list, read as one: a continuation needs both. */
function useProviderSources() {
  const providers = useProviderStatus()
  const registered = useRunners()
  return {
    providers,
    registered,
    providersPending: providers.isPending || registered.isPending,
    providersError: providers.isError || registered.isError,
    providersReady: providers.isSuccess && registered.isSuccess,
  }
}

/** One provider decision for every UI path that reopens an existing agent session. */
export function useContinuationProvider(run: ApiRun, pickedRunner: Runner | null = null) {
  const { registered, providersPending, providersError, providersReady } = useProviderSources()
  const config = useConfig()
  const untouched = isStoppedBeforeStarting(run)
  // A task saved on a removed runner has no runner of its own: it starts on the project's default
  // runner, and the server needs that runner named (hearsay-tools/squawk#3715).
  const removed = run.removedRunner !== undefined
  const needsConfig = (untouched && !run.runner) || removed
  // A runner counts when ANY of its accounts is signed in, not only the default one
  // (hearsay-tools/squawk#4116); the server refuses a continuation on a signed-out account.
  const { runners, signedOut } = useRunnerAvailability()
  const currentRunner = run.runner ?? (untouched || removed ? config.data?.defaultRunner : undefined) ?? 'claude'
  const runner = resolveRunner(pickedRunner, runners, currentRunner)
  const currentRunnerConnected = runners.includes(currentRunner)
  const required = untouched ? providersRequiredByWorkflow(run.workflowDef!, runner, runnerIds(registered.data)) : [runner]
  const missing = required.filter(provider => !runners.includes(provider))
  const canContinue = providersReady && (!needsConfig || config.isSuccess) && missing.length === 0
  const reason = continuationReason({
    needsConfig,
    configPending: config.isPending,
    configError: config.isError,
    providersPending,
    providersError,
    canContinue,
    untouched,
    missing,
  })

  return {
    runners,
    signedOut,
    currentRunner,
    runner,
    currentRunnerConnected,
    canContinue,
    providerPending: providersPending || (needsConfig && config.isPending),
    providerError: providersError,
    reason,
    runnerOverride:
      pickedRunner !== null || !currentRunnerConnected || removed
        ? runner
        : undefined,
  }
}
