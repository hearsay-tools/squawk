import type { RunnerSkill } from '@open-mercato/cezar-api-client/contract/runner-skills'
import type { RunnerModelPreset, RunnersResponse } from '@open-mercato/cezar-api-client/contract/runners'
import type {
  BackendCheck,
  CreateRunInput,
  CreateRunResponse,
  AttachmentInput,
  Runner,
  RunnerModelCatalogResponse,
  UiState,
  WorkflowDef,
} from '@open-mercato/cezar-api-client'
import { runnerEntry, runnerIds, runnerModelListName } from '@/api/runners'

export { planRunner } from '@/api/runners'

/**
 * The new-task form's picker rules and its POST body, as pure functions — the exact semantics
 * of the legacy form (web/app.js: `renderChrome`,
 * `defaultTaskSource`, the submit handler), kept apart from the component so every rule is
 * table-testable and so drift from legacy is a diff in ONE file, not a scavenger hunt.
 */

/** What the composer runs: a named workflow or a single skill. The same shape the server's
 *  `ui-state.json` stores as `lastTask`, so persistence needs no mapping. */
export type TaskSource = NonNullable<UiState['lastTask']>

/** Browser draft only. Server ui-state deliberately stores the id alone. */
export type DraftTaskSource = { source: 'workflow'; ref: string } | {
  source: 'skill'; ref: string; path?: string; typed?: true
}

/** The zero-config built-in: one agent step that runs the prompt. It is what a task with NO
 *  source picked runs as, which is why the composer's picker does not also offer it as a
 *  workflow row — "No skill" and "quick-task" would be two names for one run. */
export const QUICK_TASK = 'quick-task'

/** Prepend `source` to the recency list (newest first), dropping any earlier occurrence of the
 *  same source+ref, and cap the length. Pure so the picker's recency sort is table-testable. */
export function pushRecentSource(
  recent: readonly TaskSource[] | undefined,
  source: TaskSource,
  cap = 24,
): TaskSource[] {
  const rest = (recent ?? []).filter((s) => !(s.source === source.source && s.ref === source.ref))
  return [source, ...rest].slice(0, cap)
}

/** One model the picker suggests: the shape of `models.suggested` in `GET /api/v1/runners`. */
export type ModelPreset = RunnerModelPreset

/** A runner's fallback model suggestions, when host discovery is unavailable. Auto omits the model
 *  flag; Claude tier aliases are resolved by the CLI. Explicit pins are appended separately. The
 *  runner's own `models.suggested` from the runners list; none until that list names it. */
function suggestedModels(runners: RunnersResponse | undefined, runner: string): readonly ModelPreset[] | undefined {
  return runnerEntry(runners, runner)?.models.suggested
}

/** Shared effort catalog (#45). `value: ''` is auto — omitted on the wire, harness default.
 * Model discovery may select an ordered subset; missing metadata keeps this complete fallback. */
export const EFFORT_OPTIONS = [
  { value: '', label: 'auto', desc: 'Harness default' },
  { value: 'low', label: 'low', desc: 'Less reasoning, faster replies' },
  { value: 'medium', label: 'medium', desc: 'Balanced reasoning' },
  { value: 'high', label: 'high', desc: 'More reasoning for hard tasks' },
  { value: 'xhigh', label: 'xhigh', desc: 'Extra-high reasoning' },
  { value: 'max', label: 'max', desc: 'Maximum reasoning' },
] as const

export type EffortOption = (typeof EFFORT_OPTIONS)[number]

/** Auto plus advertised levels; without model metadata, auto plus every generic level. */
export function effortOptionsForModel(
  model: string,
  catalog?: RunnerModelCatalogResponse,
): readonly EffortOption[] {
  const fallback = EFFORT_OPTIONS
  const levels = catalog?.models.find((entry) => entry.id === model)?.effortLevels
  if (levels === undefined) return fallback

  const options: EffortOption[] = [EFFORT_OPTIONS[0]]
  const seen = new Set<string>()
  for (const level of levels) {
    if (seen.has(level)) continue
    const option = EFFORT_OPTIONS.find((candidate) => candidate.value === level)
    if (!option) continue
    seen.add(level)
    options.push(option)
  }
  return options
}

/** Resolve stale or inherited effort through the same options the picker displays. */
export function resolveEffort(
  effort: string | null | undefined,
  options: readonly EffortOption[],
): string {
  const value = effort ?? ''
  return options.some((option) => option.value === value) ? value : ''
}

/** Keep recognized presets from another backend out of a runner's custom-model escape hatch
 * (#480).
 * Unknown ids remain valid custom models; only a known cross-runner mismatch is discarded.
 *
 * A runner whose `modelIdScope` is `provider-spanning` serves ids of every provider, so its ids
 * belong to no runner alone and never conflict with another runner; a runner the runners list
 * does not name counts as `own`. This is the cockpit's half of the rule the server
 * states structurally: a runner with no default provider cannot be contradicted, which is why
 * the pi definition's `models.known` is empty in `packages/cezar/src/runners/pi/models.ts`. */
export function modelConflictsWithRunner(
  model: string,
  runner: Runner,
  runners: RunnersResponse | undefined,
): boolean {
  if (!model || suggestedModels(runners, runner)?.some((preset) => preset.id === model)) return false
  const others = (runners?.runners ?? []).filter((other) => other.id !== runner)
  if (others.some((other) => other.models.retired.includes(model))) return true
  return others.some(
    (other) =>
      other.modelIdScope !== 'provider-spanning' &&
      other.models.suggested.some((preset) => preset.id !== '' && preset.id === model),
  )
}

export function modelsForRunner(
  runner: Runner,
  runners: RunnersResponse | undefined,
  catalog?: RunnerModelCatalogResponse,
  customIds: readonly (string | null | undefined)[] = [],
): readonly ModelPreset[] {
  const discovered = catalog?.runner === runner ? catalog.models : []
  const presets = suggestedModels(runners, runner) ?? suggestedModels(runners, 'claude') ?? []
  const base = [...(discovered.length ? presets.slice(0, 1) : presets)]
  const seen = new Set(base.map((model) => model.id))
  for (const model of discovered) {
    if (!model.id || seen.has(model.id)) continue
    seen.add(model.id)
    base.push({ id: model.id, label: model.label || model.id, desc: model.description })
  }
  // Native settings may contain a provider-specific/custom id that is not in
  // Squawk's static catalog. Keep it representable so the initial selection
  // matches the agent's own configured default on every backend.
  for (const id of customIds) {
    if (!id || seen.has(id) || modelConflictsWithRunner(id, runner, runners)) continue
    seen.add(id)
    base.push({ id, label: id, desc: 'Custom or legacy model' })
  }
  return base
}

/** The model picker's status line. None until the runners list names `runner`. */
export function modelCatalogStatus(
  runner: Runner,
  runners: RunnersResponse | undefined,
  catalog: RunnerModelCatalogResponse | undefined,
  failed = false,
  fetching = false,
): string | undefined {
  const name = runnerModelListName(runners, runner)
  if (name === undefined) return undefined
  if (catalog?.stale) return `Using cached ${name} model list`
  if (failed || catalog?.source === 'unavailable') return `Latest ${name} models unavailable`
  if (fetching && !catalog) return `Loading ${name} models…`
  return undefined
}

/** {@link modelCatalogStatus} for a runner's catalog query. */
export function catalogQueryStatus(
  runner: Runner,
  runners: RunnersResponse | undefined,
  query: { data?: RunnerModelCatalogResponse | undefined; isError?: boolean; isFetching?: boolean } | undefined,
): string | undefined {
  return modelCatalogStatus(runner, runners, query?.data, query?.isError, query?.isFetching)
}

/** Which runners the pill offers, from the health checks (legacy `renderChrome`). The `claude`
 *  fallback when nothing is detected is deliberate legacy behavior: the form must always have
 *  a runner, and claude is the default engine. */
export function availableRunners(checks: readonly BackendCheck[], runners: RunnersResponse | undefined): Runner[] {
  const available = runnerIds(runners).filter((id) =>
    checks.some((c) => c.name === id && c.available),
  )
  return available.length > 0 ? available : ['claude']
}

/** The effective runner: the user's pick when still installed, else the configured default
 *  when installed, else the first available (legacy preselection order). */
export function resolveRunner(
  picked: Runner | null,
  available: readonly Runner[],
  preferred: Runner,
): Runner {
  if (picked !== null && available.includes(picked)) return picked
  if (available.includes(preferred)) return preferred
  return available[0] ?? 'claude'
}

/** The runner field shared by every NEW-run surface. Explicit/sticky intent always rides the
 * request; only an untouched pick matching the active project's known default may be omitted. */
export function runnerOverride(
  runner: Runner,
  defaultRunner: Runner | undefined,
  explicit = false,
): Runner | undefined {
  return !explicit && runner === defaultRunner ? undefined : runner
}

/** The effective model: the user's pick when it exists in the selected runner's presets, else
 *  the configured per-runner default (Settings → Agent defaults `defaultModels`, R6 1.5) when IT is a
 *  known preset, else auto (`''`). An explicit pick — including picking auto — always beats
 *  the configured default (`picked: ''` is a pick; only `null` means "never touched").
 *  Deliberately STRICTER than legacy, which kept a stale `taskModel` in state while displaying
 *  auto — here what is displayed is what is sent. */
export function resolveModel(
  picked: string | null,
  runner: Runner,
  runners: RunnersResponse | undefined,
  defaults?: Partial<Record<Runner, string | undefined>>,
  catalog?: RunnerModelCatalogResponse,
): string {
  const models = modelsForRunner(runner, runners, catalog, [picked, defaults?.[runner]])
  if (picked !== null && models.some((m) => m.id === picked)) return picked
  const preset = defaults?.[runner]
  if (preset !== undefined && models.some((m) => m.id === preset)) return preset
  return ''
}

export function sourceExists(
  source: DraftTaskSource,
  skills: readonly RunnerSkill[],
  workflows: readonly WorkflowDef[],
): boolean {
  return source.source === 'skill'
    ? skills.some((s) => s.id === source.ref && (source.path === undefined || s.path === source.path))
    : workflows.some((w) => w.name === source.ref)
}

/**
 * The effective source: the draft's own pick when the catalog still has it, else NOTHING.
 *
 * `null` is the composer's empty state — no skill and no workflow — and it is what `/new` now
 * opens on. Two mechanisms were removed here, both deliberately:
 *
 *  - the persisted `lastTask` no longer preselects. It was load-bearing for one thing: the
 *    picker remembering a way of working across visits. It also meant a skill picked once sat
 *    in the pill for every task afterwards, with no way out that reads as one (the composer
 *    offered no deselect at all — the only exit was picking the `quick-task` WORKFLOW, which
 *    is what this change is a fix for). `lastTask` is still WRITTEN, so an older cockpit reading
 *    the same `ui-state.json` behaves exactly as it always did.
 *  - the cold quick-task/first-skill fallback chain is gone with it: `null` says "nothing is
 *    selected" honestly, and `buildCreateRunBody` is the one place that turns that into the
 *    plain built-in run the server performs.
 *
 * The existence check stays: a skill deleted since it was drafted must not stay in the pill.
 */
export function resolveSource(
  candidate: DraftTaskSource | null | undefined,
  skills: readonly RunnerSkill[],
  workflows: readonly WorkflowDef[],
  unavailable = false,
): DraftTaskSource | null {
  if (candidate?.source === 'skill' && (unavailable || candidate.typed)) return candidate
  return candidate && sourceExists(candidate, skills, workflows) ? candidate : null
}

/**
 * The exact `POST /api/runs` body the legacy form sends:
 *  - a skill runs as a one-step inline chain (spec 008's API): `steps: [{ id: 'task', name, skill, prompt: '{{task}}' }]`;
 *  - a workflow goes by name;
 *  - NO source (`null` — the composer's empty state) goes by the built-in `quick-task` name,
 *    because `POST /runs` requires exactly one of `workflow`/`steps`. That name is also what
 *    the server resolves a sourceless run to, so "nothing selected" and "quick-task
 *    selected" are the same run, which is exactly why the picker offers only one of them;
 *  - an explicit/sticky `runner` always rides the request; an untouched runner is omitted only
 *    when it equals the active project's known default (unknown defaults and connected fallbacks
 *    stay explicit);
 *  - `model`/`images` only when they say something (`''`/empty mean "default").
 */
export function buildCreateRunBody(opts: {
  task: string
  /** `null` — nothing picked — runs the built-in `quick-task`. */
  source: DraftTaskSource | null
  model: string
  /** Native coding-agent settings stay visible, but a locked model is never a request override. */
  modelsLocked?: boolean
  /** Reasoning-effort pin (#45). `''` = auto, omitted on the wire. Locked with `modelsLocked`. */
  effort?: string | undefined
  runner: Runner
  /** True when the draft contains a sticky/user runner choice rather than an untouched default. */
  runnerExplicit?: boolean
  defaultRunner?: Runner | undefined
  /** Per-task agent account (spec 2026-07-29-agent-profiles) — the composer's override of the
   *  project's own selection, applying to `runner`. Absent/empty follows the project. */
  agentProfile?: string | null | undefined
  images: readonly AttachmentInput[]
  /** false → run in the repo working tree, no worktree (single runs only). Sent only when
   *  explicitly off; the default (isolated worktree) stays implicit. */
  worktree?: boolean | undefined
  /** true → autonomous run (never pauses for the user). Sent only when on. */
  autonomous?: boolean
  archiveWhenDone?: boolean
  autoMergePr?: boolean
  /** Task access: sent only when off; an absent key is on. */
  allowWorkers?: boolean
  allowMessaging?: boolean
}): CreateRunInput {
  const {
    task,
    source,
    model,
    modelsLocked,
    effort,
    runner,
    runnerExplicit,
    defaultRunner,
    agentProfile,
    images,
    worktree,
    autonomous,
    archiveWhenDone,
    autoMergePr,
    allowWorkers,
    allowMessaging,
  } = opts
  return {
    task,
    ...(source?.source === 'skill'
      ? { steps: [{ id: 'task', name: source.ref, skill: source.ref, ...(source.path !== undefined ? { skillPath: source.path } : {}), prompt: '{{task}}' }] }
      : { workflow: source?.ref ?? QUICK_TASK }),
    model: modelsLocked ? undefined : model || undefined,
    effort: modelsLocked ? undefined : effort || undefined,
    runner: runnerOverride(runner, defaultRunner, runnerExplicit),
    // Sent only when the user picked one — an absent key is "follow the project", which is what
    // every launch that never touched the control means.
    agentProfile: agentProfile || undefined,
    images: images.length > 0 ? [...images] : undefined,
    worktree: worktree === false ? false : undefined,
    autonomous: autonomous === true ? true : undefined,
    ...taskOptionFields({ archiveWhenDone, autoMergePr, allowWorkers, allowMessaging }),
  }
}

/** The completion and task access keys of a start body (hearsay-tools/cezarion#2784). Each is sent
 *  only when it differs from the server default: completion controls when on, access when off. */
export function taskOptionFields(options: { archiveWhenDone?: boolean | undefined; autoMergePr?: boolean | undefined; allowWorkers?: boolean | undefined; allowMessaging?: boolean | undefined }) {
  return {
    ...(options.archiveWhenDone ? { archiveWhenDone: true } : {}),
    ...(options.autoMergePr ? { autoMergePr: true } : {}),
    ...(options.allowWorkers === false ? { allowWorkers: false } : {}),
    ...(options.allowMessaging === false ? { allowMessaging: false } : {}),
  }
}

/** Add the task-webhook opt-in (#589) to a start body. Kept out of `buildCreateRunBody` on
 *  purpose: an automation's task is built from that too, and has no `notify`. Sent only when on —
 *  the server's rule is "absent = off". */
export function withNotify(body: CreateRunInput, notify: boolean): CreateRunInput {
  return notify ? { ...body, notify: true } : body
}

/** The automation editor persists the exact New task serialization, with only the transport-
 * specific `task` key renamed to `prompt`. Images and inbox provenance are deliberately absent:
 * an automation is a reusable template, not one browser submission. */
export function buildAutomationTask(
  opts: Parameters<typeof buildCreateRunBody>[0],
): Omit<CreateRunInput, 'task' | 'images'> & { prompt: string } {
  const { task, images: _images, ...body } = buildCreateRunBody(opts)
  return { prompt: task, ...body, ...(body.steps ? { steps: body.steps.map(({ skillPath: _path, ...step }) => step) } : {}) }
}

/** Open the newly created task. */
export function startedRunPath(response: CreateRunResponse): string {
  return `/tasks/${response.id}`
}
