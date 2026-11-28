import type { BackendCheck } from '@open-mercato/cezar-api-client'
import type { StatusDotShape, StatusDotTone } from '@/components/status-dot'
import { toolAvailabilityPresentation } from '@/lib/status-semantics'

/**
 * One reading of a probed tool, shared by the desktop Tools menu and the /tools page (the phone's
 * only door to the same probes) so the two surfaces cannot drift: green when installed, neutral
 * ring with a separate Dry run mode badge when simulated, neutral when an optional CLI is missing,
 * and danger when a required tool (`git`) is missing.
 */
export const toolTone = (check: BackendCheck): StatusDotTone => toolAvailabilityPresentation(check).availability.tone

/** Dot shape for a probed tool: ring when simulated in dry-run mode, filled otherwise. */
export const toolShape = (check: BackendCheck): StatusDotShape => toolAvailabilityPresentation(check).availability.shape

/** The canonical state word printed beside the dot: `Installed`, `Simulated`, or `Not installed`. */
export const toolStateLabel = (check: BackendCheck): string => toolAvailabilityPresentation(check).availability.label

/** The server's hint for a missing tool, verbatim; null while the tool works or has none to give. */
export const toolHint = (check: BackendCheck): string | null => (check.available ? null : (check.hint ?? null))

/** Where tools are set up: global Settings → Agents. Link with the plain react-router `Link`. */
export { GLOBAL_AGENTS_PATH as TOOL_SETTINGS_PATH, agentCardPath as toolSetupPath } from './agents-settings-path'

/** Neutral link style for the touch-first surfaces: `--foreground`, underline on hover and
 *  keyboard focus, the app's focus ring, and a 44px target wherever there is no hover. */
export const TOOL_LINK_CLASS =
  'inline-flex items-center rounded-sm text-xs font-medium text-foreground hover:underline focus-visible:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring max-md:min-h-11 no-hover:min-h-11'
