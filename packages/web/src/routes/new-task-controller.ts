import type { RunnerSkill } from '@open-mercato/cezar-api-client/contract/runner-skills'
import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'

import { createRun, postPlan, putUiState } from '@/api/client'
import { useAgentAccounts } from '@/api/agent-accounts'
import { useRunners } from '@/api/runners'
import {
  queryKeys,
  useConfig,
  useProviderStatus,
  useProjects,
  useRunnerModels,
  useRunnerSkills,
  useAgentProfiles,
  useUiState,
  useWorkflows,
  useWorkspaceConfig,
} from '@/api/queries'
import type { AttachmentInput, Runner } from '@open-mercato/cezar-api-client'
import { toast } from '@/components/ui/toaster'
import {
  autoApplyText,
  normalizePromptTemplates,
  resolveAutoApply,
} from '@/lib/prompt-templates'
import { bumpSkillUsage, orderSkillsByUsage } from '@/lib/skills'
import { uninstalledRunners, usableRunners } from '@/lib/provider-status'
import { taskWebhooks } from '@/lib/webhook'
import { useNavigate } from '@/lib/project-router'

import { prefillToast, unknownSkillPrefillText } from './new-task-prefill'
import {
  clearStartedDraft,
  draftRevision,
  readDraft,
  resolveComposerRunMode,
  writeDraft,
  type NewTaskDraft,
} from './new-task-draft'
import {
  buildCreateRunBody,
  withNotify,
  effortOptionsForModel,
  modelsForRunner,
  pushRecentSource,
  resolveEffort,
  resolveModel,
  resolveRunner,
  resolveSource,
  sourceExists,
  startedRunPath,
  type DraftTaskSource as TaskSource,
} from './new-task-form'
import type { NewTaskParams } from './new-task-params'
import { buildPlannedRunBody, pendingPlanOf, type PendingPlan } from './new-task-plan'

/**
 * The `/new` route's state and side effects (hearsay-tools/cezarion#1598), split out of
 * `NewTaskRoute` one concern per hook. Each hook takes what it reads as explicit input, so
 * the route body shows the data flow from draft to submit in one place.
 */

type Navigate = ReturnType<typeof useNavigate>
type DraftUpdate = (patch: Partial<NewTaskDraft>) => void
type ProviderStatusQuery = ReturnType<typeof useProviderStatus>
type ConfigQuery = ReturnType<typeof useConfig>
type WorkspaceConfigQuery = ReturnType<typeof useWorkspaceConfig>
type UiStateQuery = ReturnType<typeof useUiState>
type MountedRef = RefObject<boolean>

/** A picker with its own runner must not inherit a different draft identity. */
function linkedRunnerPatch(runner: Runner, account: string | undefined, stored: Runner | null): Partial<NewTaskDraft> {
  return { runner, agentProfile: account || null, ...(runner !== stored ? { model: null, effort: null } : {}) }
}

function initialDraft(draftProjectId: string | null, deepLink: NewTaskParams): NewTaskDraft {
  const stored = readDraft(draftProjectId)
  return {
    ...stored,
    ...(deepLink.runner !== undefined ? linkedRunnerPatch(deepLink.runner, deepLink.account, stored.runner) : {}),
    ...(deepLink.ref !== '' ? { text: deepLink.ref } : {}),
    ...(deepLink.skill !== ''
      ? { source: { source: 'skill', ref: deepLink.skill, ...(deepLink.skillPath !== undefined ? { path: deepLink.skillPath } : {}) } as TaskSource }
      : {}),
  }
}

/** The draft survives navigation (module store); explicit deep-link params beat it — a
 *  pasted `/new?skill=&ref=` link states intent, a leftover draft only remembers it.
 *  `linkedRunner` is the link's runner once the runners list names it: when the list answers
 *  after mount, the runner applies then. The runner pickers stay disabled until that answer. */
export function useNewTaskDraft(draftProjectId: string | null, deepLink: NewTaskParams, linkedRunner?: Runner) {
  const [draft, setDraft] = useState<NewTaskDraft>(() => initialDraft(draftProjectId, deepLink))
  const currentDraft = useRef(draft)
  useEffect(() => {
    // Claim this mounted draft even when its text matches the previous visit.
    writeDraft(currentDraft.current, draftProjectId)
  }, [draftProjectId])
  const submissionPending = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  const update: DraftUpdate = (patch) => {
    if (!mounted.current || submissionPending.current) return
    const next = { ...currentDraft.current, ...patch }
    currentDraft.current = next
    // Dictation can edit and submit in one event. Persist before submit captures its revision.
    writeDraft(next, draftProjectId)
    setDraft(next)
  }
  const runnerPending = useRef(deepLink.runner === undefined)
  useEffect(() => {
    if (!runnerPending.current || linkedRunner === undefined) return
    runnerPending.current = false
    update(linkedRunnerPatch(linkedRunner, deepLink.account, currentDraft.current.runner))
    // `update` is rebuilt each render; the patch applies once, when the runners list answers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkedRunner])
  // A suspended thread transition can return to this same mounted form. Clear it too.
  const clearStarted = (expectedRevision: number) => {
    if (draftRevision(draftProjectId) !== expectedRevision) return
    clearStartedDraft(draftProjectId, expectedRevision)
    const next = readDraft(draftProjectId)
    currentDraft.current = next
    if (mounted.current) setDraft(next)
  }
  return { draft, update, clearStarted, submissionPending, mounted }
}

/** The skill/workflow picker's catalog and the draft's resolved pick. */
export function useSourceSelection(draftSource: TaskSource | null, uiState: UiStateQuery, runner: Runner, account: string | null) {
  const workflows = useWorkflows()
  const skills = useRunnerSkills(runner, account)
  // Memoized so the picker gets a STABLE array identity across renders that don't actually
  // change the catalog or the usage stats (#408 — a raw `orderSkillsByUsage(...)` call here
  // would create a new array on EVERY render, including ones unrelated to skills/usage).
  const skillsData = skills.data
  const skillUsage = uiState.data?.skillUsage
  const skillList = useMemo(
    () => orderSkillsByUsage(skillsData ?? [], skillUsage),
    [skillsData, skillUsage],
  )
  const workflowList = workflows.data?.workflows ?? []
  const sourcesReady =
    workflows.data !== undefined && !uiState.isPending
  // The draft's pick alone — a fresh `/new` selects nothing (see `resolveSource` for what the
  // persisted `lastTask` preselection was load-bearing for, and why it is gone).
  const source = resolveSource(draftSource, skillList, workflowList, skills.unchecked)
  const selectedSkill: RunnerSkill | undefined = source?.source === 'skill'
    ? skillList.find((skill) => skill.id === source.ref && (source.path === undefined || skill.path === source.path))
    : undefined
  return { skillList, skillUsage, workflowList, sourcesReady, source, selectedSkill, skillsSettled: !skills.isPending, listUnchecked: skills.unchecked, unchecked: skills.unchecked || (source?.source === 'skill' && !selectedSkill) }
}

/**
 * Prompt templates (#413 follow-up): the same list the GitHub hand-over composer reads. The
 * footer's icon trigger inserts one by hand at the caret, and a skill whose templates are
 * assigned to it applies them on selection — but only into a box the user has not typed in
 * (`resolveAutoApply`).
 */
export function usePromptTemplates(input: {
  uiState: UiStateQuery
  source: TaskSource | null
  sourcesReady: boolean
  draftText: string
  submissionPending: RefObject<boolean>
  update: DraftUpdate
}) {
  const { uiState, source, sourcesReady, draftText, submissionPending, update } = input
  const promptTemplates = uiState.data?.promptTemplates
  const templates = useMemo(
    () => normalizePromptTemplates(promptTemplates),
    [promptTemplates],
  )
  const autoText = autoApplyText(templates, source?.source === 'skill' ? [source.ref] : [])
  const draftTextRef = useRef(draftText)
  draftTextRef.current = draftText
  const autoAppliedRef = useRef('')
  useEffect(() => {
    // Wait for the pickers' data: before it lands `source` is still a provisional guess, and
    // auto-applying against it would flash text in for a skill the user may not end up on.
    if (!sourcesReady || submissionPending.current) return
    const resolved = resolveAutoApply(draftTextRef.current, autoAppliedRef.current, autoText)
    autoAppliedRef.current = resolved.applied
    if (resolved.text !== draftTextRef.current) update({ text: resolved.text })
    // `autoText` is a derived STRING — this fires when the assigned set changes, not every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoText, sourcesReady])
  return templates
}

/** Runner, model and effort: the effective picker values (rules in new-task-form.ts). */
export function useEngineSelection(draft: NewTaskDraft, config: ConfigQuery) {
  const providers = useProviderStatus()
  const registered = useRunners()
  const runners = usableRunners(providers.data, registered.data)
  const uninstalled = uninstalledRunners(providers.data, registered.data)
  const defaultRunner = config.data?.defaultRunner
  const preferredRunner = defaultRunner ?? 'claude'
  const runner = runners.length > 0 ? resolveRunner(draft.runner, runners, preferredRunner) : null
  const displayRunner = runner ?? preferredRunner
  const providersReady = providers.isSuccess && runners.length > 0
  // The pickers read the provider status and the runners list: either one pending or failed
  // holds them the same way.
  const providerState = {
    isPending: providers.isPending || registered.isPending,
    isError: providers.isError || registered.isError,
  }
  const accountChoices = useAgentAccounts()
  const pickedAccount = accountChoices.accounts.some(choice => choice.provider === displayRunner && choice.id === draft.agentProfile)
    ? draft.agentProfile : accountChoices.repoAccount?.[displayRunner]
  const catalog = useRunnerModels(displayRunner, true, pickedAccount)
  const modelsLocked = config.data?.modelsLocked === true
  const defaultModels = config.data?.defaultModels
  const models = runner === null
    ? []
    : modelsForRunner(runner, registered.data, catalog.data, [draft.model, defaultModels?.[runner]])
  const model = runner === null
    ? ''
    : resolveModel(modelsLocked ? null : draft.model, runner, registered.data, defaultModels, catalog.data)
  const effortOptions = effortOptionsForModel(model, catalog.data)
  const effort = modelsLocked ? '' : resolveEffort(draft.effort, effortOptions)
  return {
    providers: providerState,
    registered,
    runners,
    uninstalled,
    defaultRunner,
    runner,
    displayRunner,
    providersReady,
    catalog,
    modelsLocked,
    models,
    model,
    effortOptions,
    effort,
  }
}

/**
 * Agent accounts (spec 2026-07-29-agent-profiles). These are rows of the RUNNER pill rather than
 * a pill of their own — `claude · Default` / `claude · Klaudiusz` / `codex` — so what will run is
 * readable at a glance instead of assembled from two controls. An agent with a single login stays
 * a single row, which is why a host with no extra accounts sees the list it always saw.
 */
export function useAccountSelection(displayRunner: Runner, draftAgentProfile: string | null) {
  const profiles = useAgentProfiles()
  const { accounts: accountChoices, repoAccount } = useAgentAccounts()
  // A draft account belonging to ANOTHER runner is ignored rather than sent: switching runner must
  // not silently carry a foreign account along.
  const owned = accountChoices.some(
    (choice) => choice.provider === displayRunner && choice.id === draftAgentProfile,
  )
  return { accountChoices, repoAccount, accountsSettled: !profiles.isPending, agentProfile: owned ? draftAgentProfile : null }
}

/**
 * A cold /new load mounts the textarea disabled while provider status is checked. Restore
 * the route's autofocus contract once that check enables the form, but never steal focus if
 * the user already moved elsewhere while it was pending.
 */
export function useProviderReadyFocus(providersReady: boolean) {
  const providersWereReady = useRef(false)
  const initialFocus = useRef<Element | null | undefined>(undefined)
  useEffect(() => {
    if (initialFocus.current === undefined) initialFocus.current = document.activeElement
    const becameReady = providersReady && !providersWereReady.current
    providersWereReady.current = providersReady
    if (becameReady && (document.activeElement === document.body || document.activeElement === initialFocus.current)) {
      document
        .querySelector<HTMLTextAreaElement>('textarea[aria-label="Describe a task for the agent"]')
        ?.focus()
    }
  }, [providersReady])
}

/**
 * Worktree and autonomy for this run. Plan-first forces autonomy OFF (and disables the
 * toggle): planning is inherently interactive, so the run must be able to hand the ball back.
 */
export function routeRunMode(input: {
  hasGit: boolean
  draft: NewTaskDraft
  selectedSkill: RunnerSkill | undefined
  workspaceConfig: WorkspaceConfigQuery
  source: TaskSource | null
}) {
  const defaults = input.workspaceConfig.data?.composerDefaults
  return resolveComposerRunMode({
    hasGit: input.hasGit,
    planFirst: input.draft.planFirst,
    explicitAutonomous: input.draft.autonomous,
    explicitWorktree: input.draft.worktree,
    configuredAutonomous: defaults?.autonomous ?? defaults?.inheritedAutonomous ?? 'source-dependent',
    configuredWorktree: defaults?.worktree ?? defaults?.inheritedWorktree ?? true,
    // Nothing picked runs the plain built-in workflow, and the 'source-dependent' autonomy
    // default keys off exactly that: skills default autonomous, everything else does not.
    source: input.source?.source ?? 'workflow',
  })
}

/**
 * Task webhook (#589): the toggle exists only where there is somewhere to notify — a webhook with
 * task notifications on (hearsay-tools/cezarion#1576); notify reaches all of them. Off by default
 * and not remembered — a hand-off is a per-task decision, and the thread's "Hand off" covers
 * turning it on later.
 */
export function useNotifyWebhook(urlProjectId: string | undefined) {
  const projects = useProjects()
  // The registry the project pill offers. Empty while it loads or when it errors — the pill
  // simply does not render, which is the honest state: there is no second project to offer.
  const projectList = projects.data?.projects ?? []
  const webhookProjectId = urlProjectId ?? projects.data?.bootProject
  const webhookTargets = taskWebhooks(projectList.find((entry) => entry.id === webhookProjectId))
  const [notifyChoice, setNotifyChoice] = useState(false)
  return { projectList, webhookTargets, notifyOn: webhookTargets.length > 0 && notifyChoice, setNotifyChoice }
}

/**
 * Keep keyboard order aligned with the compact visual order, including a wide sidebar
 * on a desktop viewport. CSS uses the same 550px group-width boundary.
 */
export function useCompactAgentOptions(groupRef: RefObject<HTMLDivElement | null>) {
  const [compact, setCompact] = useState(() =>
    typeof window !== 'undefined' && window.innerWidth <= 767,
  )
  useLayoutEffect(() => {
    const group = groupRef.current
    if (!group) return
    const measure = () => setCompact(window.innerWidth <= 767 || group.getBoundingClientRect().width < 550)
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(group)
    window.addEventListener('resize', measure)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  return compact
}

/**
 * The `/new?skill=&ref=` prefill: a link with a ref fills in the composer and shows one toast
 * once the pickers' data has loaded. It never starts a task.
 */
export function useNewTaskDeepLink(input: {
  deepLink: NewTaskParams
  search: URLSearchParams
  listUnchecked?: boolean
  sourcesReady: boolean
  skillList: readonly RunnerSkill[]
  update: DraftUpdate
}) {
  const navigate = useNavigate()
  const [pending, setPending] = useState(() => input.deepLink.ref !== '' || input.deepLink.skillPath !== undefined)
  useDeepLinkUrlCleanup(input.search, navigate)
  usePrefillNotice({ pending, setPending, deepLink: input.deepLink, sourcesReady: input.sourcesReady, listUnchecked: input.listUnchecked, skillList: input.skillList, update: input.update })
}

/**
 * The deep-link params are captured ONCE (the route's `useState`), because this cleans them out
 * of the URL, so a reload opens the saved draft instead of prefilling again. (The router's own
 * search, not window.location — MemoryRouter under test never touches the window.)
 */
function useDeepLinkUrlCleanup(search: URLSearchParams, navigate: Navigate) {
  const deepLinkUrlCleaned = useRef(false)
  useEffect(() => {
    if (deepLinkUrlCleaned.current) return
    deepLinkUrlCleaned.current = true
    if (search.toString() !== '') void navigate('/new', { replace: true })
    // mount-only: search is intentionally the initial URL, captured before the replace
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
}

/**
 * The prefill toast waits for the pickers' data: whether the skill exists decides the
 * wording. An unknown skill with a linked ref puts that intent into the text for quick-task.
 * Without a ref, the warning leaves the saved draft untouched.
 */
function usePrefillNotice(input: {
  pending: boolean
  setPending: (pending: boolean) => void
  listUnchecked?: boolean | undefined
  deepLink: NewTaskParams
  sourcesReady: boolean
  skillList: readonly RunnerSkill[]
  update: DraftUpdate
}) {
  const { pending, sourcesReady, deepLink } = input
  useEffect(() => {
    if (!pending || !sourcesReady) return
    input.setPending(false)
    const unknownSkill =
      !input.listUnchecked && deepLink.skill !== '' && !sourceExists({ source: 'skill', ref: deepLink.skill,
        ...(deepLink.skillPath !== undefined ? { path: deepLink.skillPath } : {}) }, input.skillList, [])
        ? deepLink.skill
        : ''
    if (unknownSkill !== '' && deepLink.ref !== '') {
      // `null` is the quick-task run, and needs no catalog lookup to say so.
      input.update({ text: unknownSkillPrefillText(deepLink.skill, deepLink.ref), source: null })
    }
    const { message, tone } = prefillToast(unknownSkill, deepLink.ref !== '')
    toast(message, { tone })
    // Focus the Start button so a bare Enter submits the reviewed form.
    document
      .querySelector<HTMLButtonElement>(
        '[data-slot="composer"] button[aria-label="Start task"], [data-slot="composer"] button[aria-label="Plan task"]',
      )
      ?.focus()
  }, [pending, sourcesReady]) // eslint-disable-line react-hooks/exhaustive-deps
}

/** The one sentence every "providers are not ready" surface on this route shows. */
export function providerUnavailableReason(providers: Pick<ProviderStatusQuery, 'isPending' | 'isError'>): string {
  if (providers.isPending) return 'Checking agent providers…'
  if (providers.isError) return 'Provider authentication could not be verified.'
  return 'Connect an agent provider before starting a task.'
}

/**
 * Remember what was actually run so the next visit preselects it (legacy `saveLastTaskSource`)
 * and float it to the top of the picker next time (recency sort) — fire-and-forget: a failed
 * write only costs the convenience.
 */
function recordStartedSource(source: TaskSource | null, uiState: UiStateQuery, queryClient: QueryClient) {
  void putUiState({
    // `null` when nothing was picked — an honest record of a plain run, and the value that
    // stops an older cockpit (which still preselects `lastTask`) restoring a stale skill.
    lastTask: source ? { source: source.source, ref: source.ref } : null,
    // Recency is a list of PICKS: a task that chose nothing did not pick quick-task, and
    // filling the list with the default would push real choices out of it.
    ...(source ? { recentSources: pushRecentSource(uiState.data?.recentSources, { source: source.source, ref: source.ref }) } : {}),
    // Frequency sort (#408): only a SKILL pick counts — the map is keyed by skill name, and a
    // workflow choice here doesn't select one directly. Gated on the CURRENT map being known:
    // the PUT merge is shallow, so bumping off an errored ui-state query (`sourcesReady` only
    // rules out `isPending`, not a failed fetch) would send a one-entry map and wipe every
    // accumulated count.
    ...(source?.source === 'skill' && uiState.data !== undefined
      ? { skillUsage: bumpSkillUsage(uiState.data.skillUsage, source.ref) }
      : {}),
  })
    .then(() => queryClient.invalidateQueries({ queryKey: queryKeys.uiState }))
    .catch(() => {})
}

/** Plan mode (#383 + spec 008) and the two ways this route starts a run. */
export function useNewTaskSubmit(input: {
  draft: NewTaskDraft
  draftProjectId: string | null
  engine: ReturnType<typeof useEngineSelection>
  agentProfile: string | null
  accountsSettled: boolean
  sourcesReady: boolean
  source: TaskSource | null
  runMode: { worktree: boolean; autonomous: boolean }
  notifyOn: boolean
  uiState: UiStateQuery
  mounted: MountedRef
  clearStarted: (revision: number) => void
}) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [plan, setPlan] = useState<PendingPlan | null>(null)
  const [planning, setPlanning] = useState(false)
  const [starting, setStarting] = useState(false)
  const { draft, draftProjectId, engine, mounted } = input
  const { providers, providersReady, runner } = engine

  const started = (created: Parameters<typeof startedRunPath>[0], submittedRevision: number) => {
    input.clearStarted(submittedRevision)
    void queryClient.invalidateQueries({ queryKey: queryKeys.runs.all })
    if (mounted.current) void navigate(startedRunPath(created))
  }

  const submit = async (text: string, images: AttachmentInput[]) => {
    const submittedRevision = draftRevision(draftProjectId)
    if (!providersReady || runner === null) throw new Error(providerUnavailableReason(providers))
    // Rejection restores the draft — nothing typed is lost to a race with the pickers.
    if (!input.sourcesReady) throw new Error('Still loading workflows and skills — try again in a second.')
    if (draft.agentProfile && !input.accountsSettled) throw new Error('Still loading agent accounts — try again in a second.')
    if (draft.planFirst) {
      // Keep the original draft while planning so Discard returns to it unchanged.
      setPlanning(true)
      try {
        const planned = await postPlan(text)
        if (mounted.current) setPlan(pendingPlanOf(text, images, planned))
      } finally {
        setPlanning(false)
      }
      return
    }
    const created = await createRun(withNotify(
      buildCreateRunBody({
        task: text,
        source: input.source,
        model: engine.model,
        modelsLocked: engine.modelsLocked,
        effort: engine.effort,
        runner,
        runnerExplicit: draft.runner !== null,
        agentProfile: input.agentProfile,
        defaultRunner: engine.defaultRunner,
        images,
        worktree: input.runMode.worktree,
        autonomous: input.runMode.autonomous,
        archiveWhenDone: draft.archiveWhenDone,
        autoMergePr: draft.autoMergePr,
        allowWorkers: draft.allowWorkers,
        allowMessaging: draft.allowMessaging,
      }),
      input.notifyOn,
    ))
    recordStartedSource(input.source, input.uiState, queryClient)
    started(created, submittedRevision)
  }

  /** ▶ Start on the reviewed plan: the (possibly edited) steps go INLINE, with the composer's
   *  current picker choices — legacy `startPlannedRun` semantics on the new surface. */
  const startPlanned = async () => {
    if (plan === null || plan.steps.length === 0 || starting || !providersReady || runner === null) return
    if (draft.agentProfile && !input.accountsSettled) return
    const submittedRevision = draftRevision(draftProjectId)
    setStarting(true)
    try {
      const created = await createRun(withNotify(
        buildPlannedRunBody({
          task: plan.task,
          steps: plan.steps,
          agentProfile: input.agentProfile,
          model: engine.model,
          modelsLocked: engine.modelsLocked,
          effort: engine.effort,
          runner,
          runnerExplicit: draft.runner !== null,
          defaultRunner: engine.defaultRunner,
          images: plan.images,
          archiveWhenDone: draft.archiveWhenDone,
          autoMergePr: draft.autoMergePr,
          allowWorkers: draft.allowWorkers,
          allowMessaging: draft.allowMessaging,
        }),
        input.notifyOn,
      ))
      setPlan(null)
      started(created, submittedRevision)
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), { tone: 'danger' })
    } finally {
      setStarting(false)
    }
  }

  return { plan, setPlan, planning, starting, submit, startPlanned }
}
