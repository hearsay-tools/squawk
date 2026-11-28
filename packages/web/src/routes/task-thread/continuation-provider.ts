import { useConfig, useProviderStatus } from '@/api/queries'
import { planRunner, runnerIds, useRunners } from '@/api/runners'
import { workerContinuationStep } from '@open-mercato/cezar-api-client/contract/run-predicates'
import { providersRequiredByWorkflow } from '@open-mercato/cezar-api-client/contract/workflows'
import type { ApiRun, Runner } from '@open-mercato/cezar-api-client'
import { useRunnerAvailability } from '@/api/agent-accounts'
import { runAccountId } from './active-provider'
import { resolveRunner } from '@/routes/new-task-form'
import { isStoppedBeforeStarting } from './run-actions'

function continuationCurrentRunner(run: ApiRun, untouched: boolean, removed: boolean, defaultRunner: Runner | undefined): Runner {
  const workerStep = workerContinuationStep(run, untouched)
  return workerStep?.runner ?? run.runner ?? (untouched || removed ? defaultRunner : undefined) ?? 'claude'
}

function workerMissingProviders(
  run: ApiRun,
  fallback: Runner,
  availability: ReturnType<typeof useRunnerAvailability>,
): Runner[] {
  const missing = new Set<Runner>()
  for (const step of run.workflowDef?.steps ?? []) {
    if (step.command !== undefined || step.kind === 'plugin') continue
    const provider = step.runner ?? fallback
    const account = step.agentProfile
      ?? (provider === (run.runner ?? fallback) ? run.agentProfile : undefined)
      ?? availability.repoAccount?.[provider]
    if (!availability.readyOn(provider, account)) missing.add(provider)
  }
  return [...missing]
}

function continuationOverride(isWorker: boolean, pickedRunner: Runner | null, currentRunnerConnected: boolean, removed: boolean, runner: Runner): Runner | undefined {
  if (isWorker) return undefined
  return pickedRunner !== null || !currentRunnerConnected || removed ? runner : undefined
}

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
export function useContinuationProvider(run: ApiRun, pickedRunner: Runner | null = null, projectId?: string) {
  const { registered, providersPending, providersError, providersReady } = useProviderSources()
  const config = useConfig(projectId)
  const untouched = isStoppedBeforeStarting(run)
  // A task saved on a removed runner has no runner of its own: it starts on the project's default
  // runner, and the server needs that runner named (hearsay-tools/squawk#3715).
  const removed = run.removedRunner !== undefined
  const needsConfig = (untouched && !run.runner) || removed
  // A continuation sends no account: each runner counts when the account the server will continue
  // it on is signed in, not only the default one (hearsay-tools/squawk#4116).
  const availability = useRunnerAvailability(projectId)
  const isWorker = run.delegation?.role === 'worker'
  const storedDefault = config.data?.defaultRunner
  const fallback = planRunner(storedDefault, runnerIds(registered.data)) ?? storedDefault
  const currentRunner = continuationCurrentRunner(run, untouched, removed, fallback)
  // Each candidate counts on the account the server would continue it on, after the runner switch
  // clears the run's account (hearsay-tools/squawk#4116).
  const accountOn = (provider: Runner, target: Runner) =>
    runAccountId(run, provider, availability.repoAccount, { original: currentRunner, target }, untouched)
  const { runners, signedOut } = availability.runnersOn((candidate) => accountOn(candidate, candidate))
  // Owned workers keep their accepted runner and account; only model and effort can change.
  const runner = isWorker ? currentRunner : resolveRunner(pickedRunner, runners, currentRunner)
  const currentRunnerConnected = runners.includes(currentRunner)
  const required = untouched ? providersRequiredByWorkflow(run.workflowDef!, runner, runnerIds(registered.data)) : [runner]
  const missing = untouched && isWorker && run.workflowDef
    ? workerMissingProviders(run, runner, availability)
    : required.filter(provider => !availability.readyOn(provider, accountOn(provider, runner)))
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
    runnerOverride: continuationOverride(isWorker, pickedRunner, currentRunnerConnected, removed, runner),
  }
}
