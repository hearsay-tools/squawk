import type { BackendCheck, OnceStatus, RunStatus } from '@open-mercato/cezar-api-client'
import type { StatusDotShape, StatusDotTone } from '@/components/status-dot'
import { attentionOfRung, deriveAttention, type Attention, type AttentionInput, type AttentionRung } from '@/lib/attention'

/**
 * Shared cockpit semantic status model (hearsay-tools/squawk#4379).
 *
 * Separates five orthogonal concepts so every route renders one canonical Sentence-case label,
 * dot tone, and shape per concept:
 *   1. `execution`  — what the task, worker, or automation is doing or ended as
 *   2. `attention`  — when a human must act (`Needs you`, `Needs permission`, `Missed`)
 *   3. `review`     — review gates (`Needs review` for tasks/workers; PR review states on GitHub)
 *   4. `archive`    — archive membership (`Archived`), independent of outcome
 *   5. `capability` — CLI availability (`Installed`, `Not installed`, `Simulated`), provider
 *                     connection (`Connected`, `Not connected`, `Could not verify`), and
 *                     capability mode (`Dry run`)
 */

export const STATUS_CATEGORIES = ['execution', 'attention', 'review', 'archive', 'capability'] as const
export type StatusCategory = (typeof STATUS_CATEGORIES)[number]

export interface StatusPresentation {
  category: StatusCategory
  label: string
  tone: StatusDotTone
  shape: StatusDotShape
  pulse: boolean
}

export const ARCHIVED_STATUS: StatusPresentation = {
  category: 'archive',
  label: 'Archived',
  tone: 'neutral',
  shape: 'filled',
  pulse: false,
}

export const DRY_RUN_MODE = {
  category: 'capability',
  label: 'Dry run',
} as const

/** High-contrast small-size text color class for each status tone, safe on every cockpit surface. */
export const SEMANTIC_TEXT_CLASS: Record<StatusDotTone, string> = {
  success: 'text-semantic-green',
  pending: 'text-semantic-amber',
  danger: 'text-semantic-red',
  accent: 'text-accent-text',
  info: 'text-semantic-info',
  running: 'text-semantic-violet',
  neutral: 'text-muted-foreground',
}

function sentenceCase(text: string): string {
  if (!text) return text
  return text.charAt(0).toUpperCase() + text.slice(1)
}

const CANONICAL_RUNG_LABEL: Record<AttentionRung, string> = {
  'needs-permission': 'Needs permission',
  failed: 'Failed',
  'needs-you': 'Needs you',
  'needs-review': 'Needs review',
  running: 'Running',
  'usage-limit': 'Usage limit',
  'waiting-on-workers': 'Waiting for workers',
  'waiting-on-subagents': 'Waiting for subagents',
  'waiting-for-ci': 'Waiting for CI',
  'waiting-for-merge': 'Waiting for merge',
  'waiting-for-command': 'Waiting for command',
  monitoring: 'Monitoring',
  'waiting-for-capacity': 'Waiting for capacity',
  queued: 'Queued',
  done: 'Done',
  cancelled: 'Cancelled',
  unseen: 'Unseen',
}

const RUNG_CATEGORY: Record<AttentionRung, StatusCategory> = {
  'needs-permission': 'attention',
  'needs-you': 'attention',
  'needs-review': 'review',
  failed: 'execution',
  running: 'execution',
  'usage-limit': 'execution',
  'waiting-on-workers': 'execution',
  'waiting-on-subagents': 'execution',
  'waiting-for-ci': 'execution',
  'waiting-for-merge': 'execution',
  'waiting-for-command': 'execution',
  monitoring: 'execution',
  'waiting-for-capacity': 'execution',
  queued: 'execution',
  done: 'execution',
  cancelled: 'execution',
  unseen: 'attention',
}

/**
 * Canonical Sentence-case label for an attention rung, preserving dynamic counts or plugin
 * summaries while unifying wording across Tasks, Task Thread, Sidebar, and Activity.
 */
export function canonicalRungLabel(
  rung: AttentionRung,
  rawLabel?: string | undefined,
  autoResumeReason?: string | null | undefined,
): string {
  if (rung === 'usage-limit' && autoResumeReason === 'provider-error') {
    return 'Provider error'
  }
  if (rung === 'waiting-on-workers' && rawLabel) {
    const normalized = rawLabel.replace(/^waiting on\b/i, 'Waiting for')
    return sentenceCase(normalized)
  }
  if (rung === 'waiting-on-subagents' && rawLabel) {
    return sentenceCase(rawLabel)
  }
  if (rung === 'monitoring' && rawLabel && rawLabel.toLowerCase() !== 'monitoring') {
    return sentenceCase(rawLabel)
  }
  return CANONICAL_RUNG_LABEL[rung]
}

export type RunStatusInput = AttentionInput & {
  autoResumeReason?: string | null | undefined
  archived?: boolean | undefined
}

/** Canonical presentation for a run from its attention rung and resume reason. */
export function runStatusPresentation(run: RunStatusInput, derived?: Attention): StatusPresentation {
  const attention = derived ?? deriveAttention(run)
  return {
    category: RUNG_CATEGORY[attention.rung],
    label: canonicalRungLabel(attention.rung, attention.label, run.autoResumeReason),
    tone: attention.tone,
    shape: attention.shape,
    pulse: attention.pulse,
  }
}

/** Canonical presentation when a caller holds only an `AttentionRung` (e.g. Activity snapshots). */
export function rungPresentation(rung: AttentionRung, rawLabel?: string): StatusPresentation {
  const attention = attentionOfRung(rung)
  return {
    category: RUNG_CATEGORY[rung],
    label: canonicalRungLabel(rung, rawLabel ?? attention.label),
    tone: attention.tone,
    shape: attention.shape,
    pulse: attention.pulse,
  }
}

/** Canonical Sentence-case label and presentation for a bare `RunStatus` enum (filters, group
 *  headers, worker rows, repo-not-landed). */
const RAW_STATUS_RUNG: Record<RunStatus, AttentionRung> = {
  waiting: 'needs-you',
  review: 'needs-review',
  running: 'running',
  queued: 'queued',
  done: 'done',
  failed: 'failed',
  cancelled: 'cancelled',
}

export function rawRunStatusPresentation(status: RunStatus): StatusPresentation {
  return rungPresentation(RAW_STATUS_RUNG[status])
}

export function rawRunStatusLabel(status: RunStatus): string {
  return rawRunStatusPresentation(status).label
}

// ---- Automations ---------------------------------------------------------------------------

const ONCE_STATUS_PRESENTATION: Record<OnceStatus, StatusPresentation> = {
  waiting: { category: 'execution', label: 'Scheduled', tone: 'running', shape: 'ring', pulse: false },
  paused: { category: 'execution', label: 'Paused', tone: 'neutral', shape: 'filled', pulse: false },
  failed: { category: 'execution', label: 'Failed', tone: 'danger', shape: 'filled', pulse: false },
  missed: { category: 'attention', label: 'Missed', tone: 'pending', shape: 'filled', pulse: false },
  archived: ARCHIVED_STATUS,
}

export function automationStatusPresentation(automation: {
  enabled: boolean
  schedule?: { type?: string } | undefined
  onceStatus?: OnceStatus | undefined
}): StatusPresentation {
  if (automation.schedule?.type === 'once') {
    const status = automation.onceStatus ?? (automation.enabled ? 'waiting' : 'paused')
    return ONCE_STATUS_PRESENTATION[status]
  }
  return automation.enabled
    ? { category: 'execution', label: 'Enabled', tone: 'success', shape: 'filled', pulse: false }
    : { category: 'execution', label: 'Paused', tone: 'neutral', shape: 'filled', pulse: false }
}

// ---- Capability & Tool Availability --------------------------------------------------------

/** A dry-run server reports mocked CLIs with `DRY_RUN=1` in the version string. That is a
 *  capability mode, not an installed binary version. */
const DRY_RUN_VERSION_PATTERN = /DRY_RUN=1\b/

export function isDryRunVersion(version: string | undefined): boolean {
  return version !== undefined && DRY_RUN_VERSION_PATTERN.test(version)
}

/** Tools required for core local workspace operations. Missing optional CLIs stay neutral;
 *  missing required tools flag danger. */
const REQUIRED_CLI_TOOLS: ReadonlySet<string> = new Set(['git'])

export interface ToolAvailability {
  availability: StatusPresentation
  /** Present when the server runs in dry-run simulation mode. */
  mode?: typeof DRY_RUN_MODE | undefined
  /** Real CLI version string; omitted when simulated in dry-run mode (kept in rawVersion). */
  version?: string | undefined
  /** Raw version string from the health probe (useful as tooltip when simulated). */
  rawVersion?: string | undefined
}

export function toolAvailabilityPresentation(check: BackendCheck): ToolAvailability {
  if (isDryRunVersion(check.version)) {
    return {
      availability: {
        category: 'capability',
        label: 'Simulated',
        tone: 'neutral',
        shape: 'ring',
        pulse: false,
      },
      mode: DRY_RUN_MODE,
      rawVersion: check.version,
    }
  }
  if (check.available) {
    return {
      availability: {
        category: 'capability',
        label: 'Installed',
        tone: 'success',
        shape: 'filled',
        pulse: false,
      },
      version: check.version,
      rawVersion: check.version,
    }
  }
  return {
    availability: {
      category: 'capability',
      label: 'Not installed',
      tone: REQUIRED_CLI_TOOLS.has(check.name) ? 'danger' : 'neutral',
      shape: 'filled',
      pulse: false,
    },
    rawVersion: check.version,
  }
}

export type ProviderConnectionStatus = 'connected' | 'disconnected' | 'not-installed' | 'unknown'

const PROVIDER_STATUS_MAP: Record<ProviderConnectionStatus, StatusPresentation> = {
  connected: { category: 'capability', label: 'Connected', tone: 'success', shape: 'filled', pulse: false },
  disconnected: { category: 'capability', label: 'Not connected', tone: 'pending', shape: 'filled', pulse: false },
  'not-installed': { category: 'capability', label: 'Not installed', tone: 'neutral', shape: 'filled', pulse: false },
  unknown: { category: 'capability', label: 'Could not verify', tone: 'danger', shape: 'filled', pulse: false },
}

export function providerStatusPresentation(status: ProviderConnectionStatus): StatusPresentation {
  return PROVIDER_STATUS_MAP[status]
}

// ---- CI Checks -----------------------------------------------------------------------------

export type CheckRollupState = 'passing' | 'failing' | 'pending' | 'unknown'

export const CI_CHECK_PRESENTATION: Record<CheckRollupState, {
  label: string
  shortLabel: string
  glyph: string
  tone: StatusDotTone
  textClass: string
}> = {
  passing: {
    label: 'Checks passing',
    shortLabel: 'Passing',
    glyph: '✓',
    tone: 'success',
    textClass: 'text-semantic-green',
  },
  failing: {
    label: 'Checks failing',
    shortLabel: 'Failing',
    glyph: '✗',
    tone: 'danger',
    textClass: 'text-semantic-red',
  },
  pending: {
    label: 'Checks pending',
    shortLabel: 'Pending',
    glyph: '○',
    tone: 'pending',
    textClass: 'text-semantic-amber',
  },
  unknown: {
    label: 'Checks unknown',
    shortLabel: 'Unknown',
    glyph: '○',
    tone: 'neutral',
    textClass: 'text-muted-foreground',
  },
}
