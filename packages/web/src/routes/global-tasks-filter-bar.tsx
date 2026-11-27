import * as React from 'react'
import { Link } from 'react-router'

import type { ProjectListEntry } from '@open-mercato/cezar-api-client'
import { controlLocation } from '@open-mercato/cezar-api-client/contract/control-locations'

import { XIcon } from '@/components/design-icons'
import { FacetFilter, SegmentedControl, ToggleChip } from '@/components/facet-filter'
import {
  GROUP_BY_OPTIONS,
  UNTAGGED,
  allStatuses,
  allWorkflows,
  canReset,
  facetCounts,
  resetCount,
  tagValuesOf,
  tasksExcludingFacet,
  toggleGroupBy,
  type AutomationNameOf,
  type FacetId,
  type GlobalTask,
  type GlobalTaskFilters,
  type GroupBy,
} from '@/lib/global-tasks'
import { allProjectTags } from '@/lib/project-tags'
import type { ListView } from '@/lib/task-groups'

/** The facet values picked inside the Filters panel. The origin row and the search box sit
 *  outside it, so they do not count. */
export function panelFacetCount(filters: GlobalTaskFilters): number {
  return (filters.projects?.length ?? 0) + filters.tags.length + filters.statuses.length + filters.workflows.length
}

/**
 * The filter row.
 *
 * Two shapes, chosen by what the facet IS rather than for variety:
 *
 *  - **Tags are laid out flat**, as one-click toggle chips. They are the reason this page exists
 *    ("show me the storefront work"), there are rarely more than a dozen, and seeing the whole
 *    set is most of the value — a popover would hide exactly what the user came to look at.
 *  - **Everything else is a searchable multi-select pill.** A workspace can hold forty projects
 *    and a dozen workflows; those do not lay out flat, and they do not need to.
 *
 * Every option carries the number of rows it would leave, counted against the list as the OTHER
 * facets narrow it — so a filter that would empty the table says so before it is clicked. And
 * every option list except the tags is derived from the tasks ACTUALLY on the page: an option
 * that can only ever produce an empty table is a dead end wearing a control's clothes. Tags are
 * the deliberate exception, taken from the registry, because a tag on a project with no tasks
 * yet is still the answer to "which repos are in this group?".
 */
export function FilterBar({
  filters,
  onToggle,
  onClearFacet,
  onClearAll,
  groupBy,
  onGroupByChange,
  projects,
  tasks,
  view,
  automationName,
}: {
  filters: GlobalTaskFilters
  onToggle: (facet: FacetId, value: string) => void
  onClearFacet: (facet: FacetId) => void
  onClearAll: () => void
  groupBy: GroupBy
  onGroupByChange: (next: GroupBy) => void
  projects: readonly ProjectListEntry[]
  tasks: readonly GlobalTask[]
  view: ListView
  /** The list's automation-name lookup, so a name match counts in every facet. */
  automationName: AutomationNameOf
}) {
  const tags = React.useMemo(() => allProjectTags(projects), [projects])

  // One `tasksExcludingFacet` per facet: the counts a facet shows must not already assume that
  // facet's own ticks, or unticking a value would promise fewer rows than it delivers.
  const counts = React.useMemo(() => {
    const per = (facet: FacetId, valueOf: (task: GlobalTask) => readonly string[]) =>
      facetCounts(tasksExcludingFacet(tasks, filters, view, facet, automationName), valueOf)
    return {
      projects: per('projects', (task) => [task.run.projectId]),
      tags: per('tags', tagValuesOf),
      statuses: per('statuses', (task) => [task.run.status]),
      workflows: per('workflows', (task) => [task.run.workflow]),
    }
  }, [tasks, filters, view, automationName])

  const withCount = (map: Map<string, number>) => (option: { value: string; label: string }) => ({
    ...option,
    count: map.get(option.value) ?? 0,
  })

  return (
    <div
      id="global-tasks-filters"
      data-slot="global-tasks-filters"
      className="flex flex-col gap-2"
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <FacetFilter
          slot="project"
          label="Project"
          selected={filters.projects ?? []}
          onToggle={(value) => onToggle('projects', value)}
          onClear={() => onClearFacet('projects')}
          options={[...new Map(tasks.map((task) => [task.run.projectId, task.projectName])).entries()]
            .map(([value, label]) => ({ value, label })).map(withCount(counts.projects))}
          emptyLabel="No tasks to filter"
        />
        <FacetFilter
          slot="status"
          label="Status"
          selected={filters.statuses}
          onToggle={(value) => onToggle('statuses', value)}
          onClear={() => onClearFacet('statuses')}
          options={allStatuses(tasks)
            .map((status) => ({ value: status, label: status }))
            .map(withCount(counts.statuses))}
          emptyLabel="No tasks to filter"
        />
        <FacetFilter
          slot="workflow"
          label="Workflow"
          selected={filters.workflows}
          onToggle={(value) => onToggle('workflows', value)}
          onClear={() => onClearFacet('workflows')}
          options={allWorkflows(tasks)
            .map((workflow) => ({ value: workflow, label: workflow }))
            .map(withCount(counts.workflows))}
          emptyLabel="No tasks to filter"
        />
        <div data-slot="group-controls" className="flex flex-wrap items-center gap-2"><span className="mx-1 h-5 w-px bg-border" aria-hidden="true" />
        <span className="text-[11px] font-medium text-soft-foreground">Group by</span>
        {/* Pressing the pressed one releases it — see `toggleGroupBy`, which is why there is
            no "None" button to hunt for. */}
        <SegmentedControl
          slot="group-by"
          label="Group tasks by"
          value={groupBy}
          options={GROUP_BY_OPTIONS}
          onChange={(picked) => onGroupByChange(toggleGroupBy(groupBy, picked))}
        /></div>
        {canReset({ filters, groupBy }) ? (
          <button
            type="button"
            data-action="clear-filters"
            onClick={onClearAll}
            className="ml-auto inline-flex h-7 items-center gap-1 rounded-full px-2 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <XIcon className="size-3" aria-hidden="true" />
            Clear
            {` (${resetCount({ filters, groupBy })})`}
          </button>
        ) : null}
      </div>

      {tags.length > 0 ? (
        <div data-slot="tag-filters" className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] font-medium text-soft-foreground">Tags</span>
          {tags.map((tag) => (
            <ToggleChip
              key={tag}
              slot="tag-filter"
              tone="tag"
              label={tag}
              count={counts.tags.get(tag) ?? 0}
              selected={filters.tags.some((picked) => picked.toLowerCase() === tag.toLowerCase())}
              onToggle={() => onToggle('tags', tag)}
            />
          ))}
          {/* Last, and named as the leftovers it is: "which repos still need labelling?" is a
              real question, and it is the one this chip answers. */}
          <ToggleChip
            slot="tag-filter"
            label="Untagged"
            count={counts.tags.get(UNTAGGED) ?? 0}
            selected={filters.tags.includes(UNTAGGED)}
            onToggle={() => onToggle('tags', UNTAGGED)}
          />
        </div>
      ) : (
        // Not silence: a workspace with no tags anywhere is the ONE state where the feature is
        // invisible, and the sentence that fixes it is one line long — with the door in it,
        // since the pane that fixes it is two clicks away and outside this page.
        <p data-slot="no-tags-hint" className="text-[11px] text-soft-foreground">
          Tag connected repositories in{' '}
          <Link to="/settings/global/projects" className="font-medium text-accent-text hover:underline">
            {controlLocation('projects')}
          </Link>{' '}
          to group their tasks together here.
        </p>
      )}
    </div>
  )
}
