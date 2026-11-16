import * as React from 'react'
import type { ReactNode } from 'react'

import { useAutomationsAvailable } from '@/lib/capabilities'
import type { SidebarView } from '@/lib/task-groups'

/**
 * The sidebar quick-list's Active/Automations filter (hearsay-tools/cezarion#1332).
 *
 * The Tasks table keeps its own Active/Archived: per-project as local state, global `/tasks` as
 * `archived=1` in the URL. Switching one must not change the other — browsing archived rows on
 * the table still needs the live runs in the sidebar. Context is what keeps every sidebar group
 * on the same question; the table is not a consumer.
 *
 * In-memory, not persisted: the filter resets to Active on every reload, and a filter that
 * silently survives a restart hides runs the user does not know are hidden.
 *
 * The third value says whether automations are available (`useAutomationsAvailable`). While they
 * are not, the view reads Active whatever was picked, and Active lists every origin
 * (hearsay-tools/squawk#1401); the pick returns when automations do.
 */
type ListViewValue = [view: SidebarView, setView: (view: SidebarView) => void, automations: boolean]

const ListViewContext = React.createContext<ListViewValue | null>(null)

export function ListViewProvider({ children }: { children: ReactNode }) {
  const [picked, setView] = React.useState<SidebarView>('active')
  const automations = useAutomationsAvailable()
  const view = automations ? picked : 'active'
  // The tuple is memoized so a re-render of the provider (which sits high in the tree) does not
  // invalidate the context for every consumer below it.
  const value = React.useMemo((): ListViewValue => [view, setView, automations], [view, automations])
  return <ListViewContext.Provider value={value}>{children}</ListViewContext.Provider>
}

/** Throws without a provider, on purpose: a default would let a sidebar consumer mount outside
 *  the shell and quietly keep its own private filter. */
export function useListView(): ListViewValue {
  const value = React.useContext(ListViewContext)
  if (!value) throw new Error('useListView must be used inside a <ListViewProvider>')
  return value
}
