import type { ReactNode } from 'react'

import { REMOTE_SETTINGS_ENABLE_COMMAND } from './remote-settings-notice'
import type { WorktreeCommandsCopy } from './worktree-commands-field'

interface WorktreeCommandsStatusProps {
  copy: WorktreeCommandsCopy
  savedCommandCount: number
  settingsAdmin: boolean | undefined
  configPath: string | null
  issue: string | null
  invalid: string | null
  children: ReactNode
}

/** Keep the saved empty state before the controls and diagnostics after them. */
export function WorktreeCommandsStatus({
  copy, savedCommandCount, settingsAdmin, configPath, issue, invalid, children,
}: WorktreeCommandsStatusProps) {
  const slot = copy.slot
  return (
    <>
      {savedCommandCount === 0 && issue === null ? (
        <p data-slot={`${slot}-empty`} className="text-xs text-muted-foreground">
          {copy.empty}
        </p>
      ) : null}
      {children}
      {settingsAdmin === false ? (
        <p data-slot={`${slot}-readonly`} className="text-xs text-foreground">
          Edit <code>{copy.key}.commands</code> in{' '}
          {configPath === null ? (
            <>the project’s <code>.ai/cezar/config.json</code></>
          ) : (
            <code className="break-all">{configPath}</code>
          )}{' '}
          on the machine running Squawk. {copy.fileEditApplies} No restart is needed. To edit
          here, the host operator runs <code>{REMOTE_SETTINGS_ENABLE_COMMAND}</code>.
        </p>
      ) : null}
      {issue !== null ? (
        <p data-slot={`${slot}-issue`} className="text-xs text-danger">
          config.json has an invalid {copy.key} ({issue}) — saving replaces it.
        </p>
      ) : null}
      {invalid !== null ? (
        <p data-slot={`${slot}-invalid`} className="text-xs text-danger">
          {invalid}
        </p>
      ) : null}
    </>
  )
}
