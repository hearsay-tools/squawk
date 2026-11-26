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

  it('shrink-wraps the select so the chevron stays inside its border', () => {
    const { container } = render(
      <div className="flex flex-col">
        <SettingsSelect aria-label="Pick" className="w-64">
          <option value="a">A</option>
        </SettingsSelect>
      </div>,
    )
    const wrapper = container.querySelector('[data-slot="settings-select"]')!
    expect(wrapper.className).toContain('w-fit')
    expect(wrapper.firstElementChild?.tagName).toBe('SELECT')
    expect(wrapper.firstElementChild?.className).toContain('w-64')
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
