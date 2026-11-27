import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

afterEach(cleanup)

import {
  BoardPage,
  FormPage,
  PAGE_SHELL_TEMPLATES,
  PageShell,
  PageShellActionButton,
  PageShellEmptyState,
  PageShellSparseFooter,
  PageShellSplitPane,
  ReadingPage,
  SplitPage,
  TablePage,
  pageShellDensity,
  type PageShellDensity,
} from './index'

describe('pageShellDensity', () => {
  it('classifies 0 as empty, 1..3 as sparse, and 4+ as full', () => {
    expect(pageShellDensity(0)).toBe('empty')
    expect(pageShellDensity(1)).toBe('sparse')
    expect(pageShellDensity(3)).toBe('sparse')
    expect(pageShellDensity(4)).toBe('full')
    expect(pageShellDensity(2, 2)).toBe('sparse')
    expect(pageShellDensity(3, 2)).toBe('full')
  })
})

describe('PageShell named templates', () => {
  const NAMED = [
    ['Table', TablePage],
    ['Split', SplitPage],
    ['Reading', ReadingPage],
    ['Form', FormPage],
    ['Board', BoardPage],
  ] as const

  it('exposes all five required templates', () => {
    expect(PAGE_SHELL_TEMPLATES).toEqual(['Table', 'Split', 'Reading', 'Form', 'Board'])
  })

  for (const [template, Component] of NAMED) {
    for (const density of ['empty', 'sparse', 'full'] as PageShellDensity[]) {
      it(`renders ${template} in ${density} density with fixed header slots`, () => {
        const { container } = render(
          <Component
            route={`test-${template.toLowerCase()}`}
            density={density}
            header={{
              title: `${template} title`,
              scope: 'acme-api',
              subtitle: 'Short context line',
              status: <span>Synced</span>,
              secondaryActions: <PageShellActionButton>Refresh</PageShellActionButton>,
              primaryAction: <PageShellActionButton variant="primary">Create</PageShellActionButton>,
            }}
            emptyState={
              <PageShellEmptyState
                title="Nothing here yet"
                description="Start by creating the first entry."
                actions={<PageShellActionButton variant="primary">Create first</PageShellActionButton>}
              />
            }
            sparseFooter={<PageShellSparseFooter summary="Showing 2 items." />}
          >
            <div data-testid="content">Body rows</div>
          </Component>,
        )

        const root = container.querySelector('[data-slot="page-shell"]')!
        expect(root.getAttribute('data-template')).toBe(template)
        expect(root.getAttribute('data-density')).toBe(density)
        expect(root.getAttribute('data-route')).toBe(`test-${template.toLowerCase()}`)

        // Fixed header slots
        const heading = screen.getByRole('heading', { level: 1 })
        expect(heading.textContent).toContain(`${template} title`)
        expect(heading.textContent).toContain('· acme-api')
        expect(container.querySelector('[data-slot="page-header-subtitle"]')?.textContent).toBe('Short context line')
        expect(container.querySelector('[data-slot="page-header-status"]')?.textContent).toBe('Synced')
        expect(container.querySelector('[data-slot="page-header-secondary"]')).not.toBeNull()
        expect(container.querySelector('[data-slot="page-header-primary"]')).not.toBeNull()

        if (density === 'empty') {
          expect(screen.getByRole('heading', { level: 2, name: 'Nothing here yet' })).toBeDefined()
          expect(screen.queryByTestId('content')).toBeNull()
          expect(container.querySelector('[data-slot="page-shell-sparse-footer"]')).toBeNull()
        } else if (density === 'sparse') {
          expect(screen.getByTestId('content')).toBeDefined()
          expect(container.querySelector('[data-slot="page-shell-sparse-footer"]')?.textContent).toContain('Showing 2 items.')
        } else {
          expect(screen.getByTestId('content')).toBeDefined()
          expect(container.querySelector('[data-slot="page-shell-sparse-footer"]')).toBeNull()
        }
      })
    }
  }

  it('supports custom headerSlot names for backwards compatibility with route selectors', () => {
    const { container } = render(
      <PageShell
        template="Table"
        route="repo-git"
        density="full"
        header={{
          title: 'Not landed',
          headerSlot: 'repo-header',
          subtitle: 'Finished tasks not on main',
          subtitleSlot: 'repo-meta',
        }}
      >
        <div>Rows</div>
      </PageShell>,
    )

    expect(container.querySelector('[data-slot="repo-header"] h1')?.textContent).toBe('Not landed')
    expect(container.querySelector('[data-slot="repo-header"] [data-slot="repo-meta"]')?.textContent).toBe('Finished tasks not on main')
  })

  it('renders PageShellSplitPane with list and detail regions', () => {
    const { container } = render(
      <PageShellSplitPane list={<div>List pane</div>} detail={<div>Detail pane</div>} />,
    )
    expect(container.querySelector('[data-slot="page-shell-split-list"]')?.textContent).toBe('List pane')
    expect(container.querySelector('[data-slot="page-shell-split-detail"]')?.textContent).toBe('Detail pane')
  })

  it('layers default block padding in @layer components so bottom-clearance utilities apply while gutter stays unlayered', () => {
    const css = readFileSync(resolve(import.meta.dirname, 'page-shell.css'), 'utf8')
    expect(css).toMatch(/@layer components\s*\{\s*\[data-slot='page-shell'\]\s*\{\s*padding-block:\s*28px 36px;\s*\}\s*\}/)
    expect(css).toMatch(/\[data-slot='page-shell'\]\s*\{[^}]*padding-inline:\s*var\(--page-shell-gutter\);/)
  })
})
