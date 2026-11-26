import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { canonicalRunnerName } from './agent-descriptors'
import { SettingsSelect } from './settings-select'

describe('SettingsSelect', () => {
  it('draws a trailing chevron beside the native select', () => {
    const { container } = render(
      <SettingsSelect aria-label="Pick">
        <option value="a">A</option>
      </SettingsSelect>,
    )
    expect(screen.getByLabelText('Pick').className).toContain('pr-8')
    expect(container.querySelector('[data-slot="settings-select"] svg')).not.toBeNull()
  })
})

describe('canonicalRunnerName', () => {
  it('maps runner ids to one display name', () => {
    expect(canonicalRunnerName('claude')).toBe('Claude Code')
    expect(canonicalRunnerName('opencode')).toBe('OpenCode')
    expect(canonicalRunnerName('pi', 'pi')).toBe('Pi')
    expect(canonicalRunnerName('other', 'Other')).toBe('Other')
  })
})
