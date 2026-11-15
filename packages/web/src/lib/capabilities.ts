import { useEffect, useRef } from 'react'
import type { HealthResponse } from '@open-mercato/cezar-api-client'

import { useHealth } from '@/api/queries'

/**
 * The one browser-side reading of `capabilities.automations` (hearsay-tools/squawk#1401). Every
 * Automations entry asks here: the nav item, the ⌘K view, the sidebar tab, the Tasks-page origin
 * chip, the prompt templates, the automation names and the Automations page.
 *
 * Only a health payload that says `automations: true` makes them available. A payload without
 * the field, `false`, and no payload yet all read as unavailable, so no entry appears before the
 * server has answered and none of them disappears again once it has.
 */
export function automationsAvailable(
  health: { capabilities?: Partial<HealthResponse['capabilities']> | undefined } | null | undefined,
): boolean {
  return health?.capabilities?.automations === true
}

/** `unknown` until this component has seen a health payload; after that, the last one it saw. */
export type AutomationsAvailability = 'unknown' | 'available' | 'unavailable'

/**
 * The availability from the last health payload this component committed. A refetch that fails,
 * or a project switch whose health has not loaded yet, keeps the previous answer instead of
 * hiding every entry until the payload returns. Only a committed render records the payload: a
 * render React discards leaves the kept answer alone.
 */
export function useAutomationsAvailability(): AutomationsAvailability {
  const health = useHealth().data
  const lastKnown = useRef<HealthResponse | undefined>(undefined)
  useEffect(() => { if (health) lastKnown.current = health }, [health])
  const known = health ?? lastKnown.current
  if (!known) return 'unknown'
  return automationsAvailable(known) ? 'available' : 'unavailable'
}

/** `useAutomationsAvailability`, with `unknown` read as unavailable. */
export function useAutomationsAvailable(): boolean {
  return useAutomationsAvailability() === 'available'
}
