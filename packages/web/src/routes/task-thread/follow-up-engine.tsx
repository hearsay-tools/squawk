import { latestSessionStep, sessionRunner } from '@open-mercato/cezar-api-client/contract/run-predicates'
import { useRunCacheWriter } from '@/api/use-run-cache-writer'
import { runAddress } from '@/api/run-address'
import { CpuIcon, GaugeIcon, TerminalIcon } from '@/components/design-icons'
import { useMutation } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'

import { useAgentAccounts } from '@/api/agent-accounts'
import { ApiError, continueRun } from '@/api/client'
import { useConfig, useRunnerModels } from '@/api/queries'
import { useRunners } from '@/api/runners'
import { DEFAULT_AGENT_ACCOUNT_ID } from '@open-mercato/cezar-api-client/contract/agent-profiles'
import type { ApiRun, ContinueResponse, AttachmentInput, Runner } from '@open-mercato/cezar-api-client'
import { PickerPill, PickerPillGroup, RunnerPill } from '@/components/picker-pill'
import {
  effortOptionsForModel,
  modelsForRunner,
  catalogQueryStatus,
  resolveEffort,
  resolveModel,
} from '@/routes/new-task-form'
import { useContinuationProvider } from './continuation-provider'
import { runActionFlags } from './run-actions'

/** What the thread needs to offer Continue from its composer. */
export interface ContinueAction {
  /** Is there a session to reopen at all? (`runActionFlags.continueRun` — the same gate the
   *  header's Continue button uses.) Everything else is inert when this is false. */
  available: boolean
  /** Whether provider discovery currently permits reopening the session. */
  canContinue: boolean
  /** Fixed recovery copy when no provider can continue the run. */
  reason?: string | undefined
  /** True while provider status is still loading. */
  providerPending: boolean
  startsNewConversation: boolean
  skillRunner: Runner
  skillAccount: string | null
  /** The runner, model and effort pills for the reopened session. */
  pills: ReactNode
  /**
   * Reopen the session, starting it on this prompt. An empty draft is the legacy one-click
   * Continue: the engine opens with its own "Continue.". REJECTS with the server's message
   * rather than toasting itself, so the composer can restore the draft it optimistically
   * cleared — nothing the user typed is lost to a 409.
   */
  continueWith: (text: string, images: AttachmentInput[]) => Promise<ContinueResponse>
}

type ContinueConfig = ReturnType<typeof useConfig>['data']
type ContinueCatalog = ReturnType<typeof useRunnerModels>['data']
type ContinueRunners = ReturnType<typeof useRunners>['data']
type ContinueAccounts = ReturnType<typeof useAgentAccounts>

function resolveContinueModel(
  run: ApiRun, runner: Runner, runnerChanged: boolean, modelsLocked: boolean,
  config: ContinueConfig, catalog: ContinueCatalog, registered: ContinueRunners,
  pickedModel: string | null, pickedEffort: string | null,
) {
  // While the runner is unchanged, the model pill starts on the run's own pin; switching the
  // runner invalidates that pin and falls back to the new backend's configured default / auto.
  const modelDefaults =
    !modelsLocked && !runnerChanged && run.model
      ? { ...config?.defaultModels, [runner]: run.model }
      : config?.defaultModels
  const effectivePickedModel = modelsLocked ? null : pickedModel
  const models = modelsForRunner(runner, registered, catalog, [effectivePickedModel, modelDefaults?.[runner]])
  const model = resolveModel(effectivePickedModel, runner, registered, modelDefaults, catalog)
  const effortOptions = effortOptionsForModel(model, catalog)
  const rawEffort = modelsLocked ? '' : (pickedEffort ?? run.effort ?? '')
  const effort = resolveEffort(rawEffort, effortOptions)
  const mustClearStoredEffort =
    !modelsLocked && pickedEffort === null && rawEffort !== '' && effort === ''

  return { models, model, effortOptions, effort, mustClearStoredEffort }
}

/**
 * The account this Continue runs on, for the skill list. A Continue names no account: it stays on
 * the STEP that spawned the session (`sessionId` and `profileId` are a pair), and a runner switch
 * falls back to what the project resolves to for THAT agent.
 */
function resolveContinueAccount(run: ApiRun, runner: Runner, runnerChanged: boolean, repoAccount: ContinueAccounts['repoAccount']) {
  const sessionStep = latestSessionStep(run.steps)
  const runAccount = sessionStep?.profileId ?? run.agentProfile ?? DEFAULT_AGENT_ACCOUNT_ID
  return { sessionStep, account: runnerChanged ? repoAccount?.[runner] ?? DEFAULT_AGENT_ACCOUNT_ID : runAccount }
}

type ContinueModel = ReturnType<typeof resolveContinueModel>

function continueRequestBody(
  text: string, images: AttachmentInput[], runnerOverride: Runner | undefined,
  modelsLocked: boolean, runnerChanged: boolean,
  pickedModel: string | null, pickedEffort: string | null,
  { model, effort, mustClearStoredEffort }: ContinueModel,
) {
  return {
    // An empty draft posts no `text` at all, so the server's default opening prompt
    // ("Continue.") still applies — one-click Continue, unchanged.
    text: text.trim() ? text : undefined,
    images: images.length ? images : undefined,
    // Send an override only for a pill the user actually touched; otherwise omit it so the
    // server keeps the run's current backend/model. If that backend disconnected, the
    // connected fallback must be explicit even when the pills were untouched.
    runner: runnerOverride,
    // The model and effort the pills DISPLAY (#411): a picked pill always writes its value,
    // and a runner switch — pick or connected fallback — writes what the pills now show even
    // when untouched, because the switch re-resolves both against the new runner
    // (`modelDefaults`/`resolveEffort` above) and the record must match the display.
    // `undefined` = keep the run's value, `''` = auto.
    model:
      !modelsLocked && (pickedModel !== null || runnerChanged)
        ? model
        : undefined,
    effort:
      !modelsLocked && (pickedEffort !== null || runnerChanged)
        ? effort
        : mustClearStoredEffort
          ? ''
          : undefined,
  }
}

function continueStartsNewConversation(
  run: ApiRun, sessionStep: ReturnType<typeof resolveContinueAccount>['sessionStep'],
  runner: Runner,
) {
  return !!sessionStep && (
    runner !== sessionRunner(sessionStep, run) ||
    (run.agentProfile ?? sessionStep.profileId ?? DEFAULT_AGENT_ACCOUNT_ID) !==
      (sessionStep.profileId ?? DEFAULT_AGENT_ACCOUNT_ID)
  )
}

function continueLabels({ models, model, effortOptions, effort }: ContinueModel) {
  return {
    modelLabel: models.find((m) => m.id === model)?.label ?? 'auto',
    effortLabel: effortOptions.find((option) => option.value === effort)?.label ?? 'auto',
  }
}

/**
 * The follow-up composer's Continue (#401): the same runner + model pills the /new composer
 * offers, so a follow-up can pick which backend and model reopen the session. The pills DEFAULT
 * to the run's current backend/model — untouched, the POST omits both and the server keeps the
 * run's engine (backward compat).
 *
 * A hook rather than a self-contained button, because the composer owns the draft: the prompt
 * the user typed and the engine they picked have to reach `POST /continue` in ONE request, and
 * the pills' state lives here.
 */
export function useContinueAction(run: ApiRun): ContinueAction {
  const writer = useRunCacheWriter()
  const available = runActionFlags(run).continueRun
  const config = useConfig()
  // null = "not touched": the pills fall back to the run's current backend/model, so an
  // untouched Continue behaves exactly as before this feature existed.
  const [pickedRunner, setPickedRunner] = useState<Runner | null>(null)
  const [pickedModel, setPickedModel] = useState<string | null>(null)
  const [pickedEffort, setPickedEffort] = useState<string | null>(null)
  // The task route reuses this view across parameter changes, so a pick from run A must not
  // stick when the user opens cached run B. Reset every pill on `run.id` — effort, model
  // and runner all leak the same way.
  const [pickedRunId, setPickedRunId] = useState(run.id)
  if (pickedRunId !== run.id) {
    setPickedRunId(run.id)
    setPickedRunner(null)
    setPickedModel(null)
    setPickedEffort(null)
  }

  const continuation = useContinuationProvider(run, pickedRunner)
  const { runners, canContinue, currentRunner, runner } = continuation
  // The catalog belongs to the runner this continuation would use (#794), so switching the
  // runner pill re-reads that backend's own models. Only a run that can actually be continued
  // fetches at all — every other thread (running, queued, closed with no session) would be
  // fetching it to render nothing.
  const { sessionStep, account } = resolveContinueAccount(run, runner, runner !== currentRunner, useAgentAccounts().repoAccount)
  const catalog = useRunnerModels(runner, available, account)
  const registered = useRunners()
  const modelsLocked = config.data?.modelsLocked === true
  const runnerChanged = runner !== currentRunner
  const modelSelection = resolveContinueModel(
    run, runner, runnerChanged, modelsLocked, config.data, catalog.data, registered.data, pickedModel, pickedEffort,
  )
  const { models, model, effortOptions, effort } = modelSelection
  const { modelLabel, effortLabel } = continueLabels(modelSelection)

  const mutation = useMutation({
    mutationFn: ({ text, images }: { text: string; images: AttachmentInput[] }) => {
      if (!canContinue) {
        return Promise.reject(new Error(continuation.reason ?? 'Connect an agent provider to continue.'))
      }
      return continueRun(runAddress(run.id), continueRequestBody(
        text, images, continuation.runnerOverride, modelsLocked, runnerChanged,
        pickedModel, pickedEffort, modelSelection,
      ))
    },
    // Capture the run's project at the start: navigation must not retarget the refresh.
    onMutate: () => runAddress(run.id),
    onSuccess: (_result, _input, address) => writer.invalidateAfter('continue', address),
    onError: (error, _input, address) => {
      if (error instanceof ApiError && error.status === 409 && address) {
        void writer.invalidateAfter('continue', address)
      }
    },
  })

  return {
    skillRunner: runner,
    skillAccount: account,
    available,
    canContinue,
    startsNewConversation: continueStartsNewConversation(run, sessionStep, runner),
    reason: continuation.reason,
    providerPending: continuation.providerPending,
    pills: (
      <div data-slot="follow-up-engine" className="session-engine-controls">
<PickerPillGroup>
        {/* Shown when there is a choice to make. A host with one runner sees no pill. */}
        {runners.length > 1 ? (
          <RunnerPill
            icon={<TerminalIcon aria-hidden="true" className="size-[18px] shrink-0 text-accent-text" />}
            fieldLabel
            runners={runners}
            value={runner}
            onPick={(next) => {
              // Changing the AGENT invalidates the model pick: presets are per-runner.
              if (next !== runner) {
                setPickedRunner(next)
                setPickedModel(null)
              }
            }}
          />
        ) : (
          <PickerPill
            icon={<TerminalIcon aria-hidden="true" className="size-[18px] shrink-0 text-accent-text" />}
            fieldLabel
            readOnly
            slot="session-runner-value"
            ariaLabel="Runner"
            label={runner}
            value={runner}
            onPick={() => {}}
            options={[{ value: runner, label: runner }]}
          />
        )}
        <PickerPill
          icon={<CpuIcon aria-hidden="true" className="size-[18px] shrink-0 text-accent-text" />}
          fieldLabel
          slot="follow-up-model-pill"
          ariaLabel="Model"
          label={modelLabel}
          value={model}
          readOnly={modelsLocked}
          disabledHint="Model selection is locked to native coding-agent settings."
          onPick={(next) => {
            setPickedModel(next)
            const nextOptions = effortOptionsForModel(next, catalog.data)
            if (effort !== '' && resolveEffort(effort, nextOptions) === '') setPickedEffort('')
          }}
          options={models.map((m) => ({ value: m.id, label: m.label, desc: m.desc }))}
          status={catalogQueryStatus(runner, registered.data, catalog)}
        />
        <PickerPill
          icon={<GaugeIcon aria-hidden="true" className="size-[18px] shrink-0 text-accent-text" />}
          fieldLabel
          slot="follow-up-effort-pill"
          ariaLabel="Effort"
          label={effortLabel}
          value={effort}
          readOnly={modelsLocked}
          disabledHint="Effort selection is locked to native coding-agent settings."
          onPick={(next) => setPickedEffort(next)}
          options={effortOptions.map((option) => ({
            value: option.value,
            label: option.label,
            desc: option.desc,
          }))}
        />
</PickerPillGroup>
      </div>
    ),
    continueWith: (text, images) => mutation.mutateAsync({ text, images }),
  }
}
