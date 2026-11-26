import { ChevronDownIcon, TerminalIcon } from '@/components/design-icons'

import { useRef, type ComponentProps } from 'react'
import { DefaultAgentPicker, type AgentPickerRow } from '@/components/default-agent-picker'
import { canonicalRunnerName } from './agent-descriptors'

/** A row's label with the runner part in its canonical name ("Claude Code", never "claude"),
 *  keeping any " · <account>" suffix. */
function canonicalRow(row: AgentPickerRow): AgentPickerRow {
  const name = canonicalRunnerName(row.runner.id, row.runner.pickerLabel)
  const suffix = row.label.startsWith(row.runner.pickerLabel) ? row.label.slice(row.runner.pickerLabel.length) : ''
  return { ...row, label: `${name}${suffix}` }
}

/** Settings presents the shared authenticated account choices in a compact disclosure.
 * Selection still goes through the shared picker, including its per-account write guards. */
export function SettingsAgentPicker(props: ComponentProps<typeof DefaultAgentPicker>) {
  const disclosure = useRef<HTMLDetailsElement>(null)
  const rows = props.rows.map(canonicalRow)
  const selected = rows.find((row) => row.runner.id === props.runner && row.account === props.accountFor(row.runner.id))
  const fallback = rows.find((row) => row.runner.id === props.runner)?.runner.displayName
  return (
    <details ref={disclosure} className="settings-agent-picker">
      <summary>
        <TerminalIcon aria-hidden="true" className="size-4 text-accent-text" />
        <span className="min-w-0 flex-1">{selected?.label ?? canonicalRunnerName(props.runner, fallback)}</span>
        <ChevronDownIcon aria-hidden="true" className="size-4 text-muted-foreground" />
      </summary>
      <DefaultAgentPicker {...props} rows={rows} onPick={(...args) => {
        props.onPick(...args)
        if (disclosure.current) disclosure.current.open = false
      }} />
    </details>
  )
}
