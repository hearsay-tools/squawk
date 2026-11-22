import {
  closestCenter,
  DndContext,
  KeyboardCode,
  KeyboardSensor,
  MeasuringStrategy,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type Modifier,
  type ScreenReaderInstructions,
} from '@dnd-kit/core'
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import * as React from 'react'
import type { ProjectListEntry } from '@open-mercato/cezar-api-client'
import { moveProjectId } from '@/lib/project-order'
import type { RailSort } from './project-rail'

type RailProjectsProps = {
  projects: readonly ProjectListEntry[]
  onReorder: (ids: readonly string[]) => void
  renderProject: (project: ProjectListEntry, sort: RailSort) => React.ReactNode
}

/** One rail row, sortable. `useSortable` is a hook, so each row is its own component. */
function SortableRailProject({ project, position, total, renderProject }: {
  project: ProjectListEntry
  position: number
  total: number
  renderProject: RailProjectsProps['renderProject']
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: project.id })
  return renderProject(project, {
    setNodeRef,
    setActivatorNodeRef,
    // Translate preserves the fixed 52px row height.
    style: { transform: CSS.Translate.toString(transform), transition },
    listeners,
    attributes: attributes as unknown as Record<string, unknown>,
    isDragging,
    position,
    total,
  })
}

/** A column, so a row moves up and down only: sideways it would leave a 60px rail. */
const restrictToRailAxis: Modifier = ({ transform }) => ({ ...transform, x: 0 })

/**
 * The pointer sensor for a mouse or a pen only. A finger goes to the touch sensor below: a
 * collapsed mark keeps the browser's default `touch-action` so the rail still scrolls under a
 * swipe, and the browser cancels a pointer-driven drag the moment that swipe becomes a scroll.
 * Both sensors cannot share a press — dnd-kit lets the first activator (`pointerdown`, before
 * `touchstart`) own it — so this one has to step aside for touch.
 */
class RailPointerSensor extends PointerSensor {
  static override activators = [
    {
      eventName: 'onPointerDown' as const,
      handler: ({ nativeEvent }: React.PointerEvent, options: Parameters<(typeof PointerSensor.activators)[number]['handler']>[1]) =>
        nativeEvent.pointerType !== 'touch' && PointerSensor.activators[0]!.handler({ nativeEvent } as React.PointerEvent, options),
    },
  ]
}

/** A finger lifts a project with a long press, so a swipe across the rail stays a scroll. The
 *  tolerance lets a resting finger wobble without cancelling the press. */
const RAIL_TOUCH_CONSTRAINT = { delay: 250, tolerance: 5 }

/** Space lifts, so Enter on a collapsed mark still follows its link. */
const RAIL_KEYBOARD_CODES = {
  start: [KeyboardCode.Space],
  cancel: [KeyboardCode.Esc],
  end: [KeyboardCode.Space, KeyboardCode.Enter, KeyboardCode.Tab],
}

/** Measure the rows all the time, not only once a drag starts. dnd-kit's default measures the
 *  drop targets in an effect AFTER the lift, so an arrow key or a pointer release in that gap
 *  resolves to no target and the drop silently does nothing — seen in a real browser as a lost
 *  keyboard move. A rail holds a few dozen fixed-height rows, so measuring them is cheap. */
const RAIL_MEASURING = { droppable: { strategy: MeasuringStrategy.Always } }

const RAIL_INSTRUCTIONS: ScreenReaderInstructions = {
  draggable:
    'To reorder projects, press Space to pick this project up. Use the up and down arrow keys to move it, Space to drop it, or Escape to cancel.',
}

/**
 * The rail's reorder wiring: sensors, the persisted move, the click guard, the announcements.
 *
 * The click guard exists because the rows are links. dnd-kit stops the click that ends a pointer
 * drag from PROPAGATING, so React Router's handler never runs — but it does not cancel the click,
 * and an anchor's default action is a full page load. A capture listener on `window` (ahead of
 * dnd-kit's on `document`) cancels it for the length of the drag and one tick after.
 */
function useRailSorting(given: readonly ProjectListEntry[], onReorder: ((ids: readonly string[]) => void) | undefined) {
  // The order a drop just chose, shown until the store's order arrives. The store answers a
  // macrotask late (TanStack Query notifies its observers on `setTimeout(0)`), while dnd-kit
  // clears the drag's transform in the drop's own render — so without this the rail paints one
  // frame of the OLD order, the row snaps back towards its old slot, and then animates to its new
  // one (seen in real Chrome, hearsay-tools/cezarion#438). Keyed on the `given` array it was set
  // against: any new array from the store replaces it, including the one a failed write restores.
  const [dropped, setDropped] = React.useState<{ base: readonly ProjectListEntry[]; ids: readonly string[] } | null>(null)
  const projects = React.useMemo(() => {
    if (dropped === null || dropped.base !== given) return given
    const byId = new Map(given.map((project) => [project.id, project]))
    return dropped.ids.flatMap((id) => byId.get(id) ?? [])
  }, [dropped, given])
  const ids = React.useMemo(() => projects.map((project) => project.id), [projects])
  const sensors = useSensors(
    useSensor(RailPointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: RAIL_TOUCH_CONSTRAINT }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates, keyboardCodes: RAIL_KEYBOARD_CODES }),
  )

  const releaseClickGuard = React.useRef<(() => void) | null>(null)
  const armClickGuard = React.useCallback(() => {
    releaseClickGuard.current?.()
    const cancel = (event: MouseEvent) => event.preventDefault()
    window.addEventListener('click', cancel, true)
    releaseClickGuard.current = () => {
      window.removeEventListener('click', cancel, true)
      releaseClickGuard.current = null
    }
  }, [])
  const disarmClickGuard = React.useCallback(() => {
    // After the click that ends the drag has been dispatched, which happens in the same task.
    const release = releaseClickGuard.current
    window.setTimeout(() => release?.(), 0)
  }, [])
  React.useEffect(() => () => releaseClickGuard.current?.(), [])

  const onDragEnd = React.useCallback(
    (event: DragEndEvent) => {
      disarmClickGuard()
      const { active, over } = event
      if (!onReorder || over === null || over.id === active.id) return
      // The WHOLE visible order is persisted, not just the moved id, so nothing re-sorts itself
      // on the next read.
      const next = moveProjectId(ids, ids.indexOf(String(active.id)), ids.indexOf(String(over.id)))
      if (!next.some((id, index) => id !== ids[index])) return
      setDropped({ base: given, ids: next })
      onReorder(next)
    },
    [disarmClickGuard, given, ids, onReorder],
  )

  // dnd-kit's defaults would read out the project SLUG. The name and the position are what a
  // person needs to reorder a list without seeing it.
  const announcements = React.useMemo<Announcements>(() => {
    const describe = (id: string | number) => {
      const index = ids.indexOf(String(id))
      return { name: projects[index]?.name ?? String(id), position: `position ${index + 1} of ${ids.length}` }
    }
    return {
      onDragStart: ({ active }) => `Picked up ${describe(active.id).name}, ${describe(active.id).position}.`,
      onDragOver: ({ active, over }) =>
        over ? `${describe(active.id).name} moved to ${describe(over.id).position}.` : `${describe(active.id).name} is not over a drop position.`,
      onDragEnd: ({ active, over }) =>
        over ? `${describe(active.id).name} dropped at ${describe(over.id).position}.` : `${describe(active.id).name} dropped. The order is unchanged.`,
      onDragCancel: ({ active }) => `Reordering cancelled. ${describe(active.id).name} returned to ${describe(active.id).position}.`,
    }
  }, [ids, projects])

  return { projects, ids, sensors, announcements, onDragStart: armClickGuard, onDragEnd, onDragCancel: disarmClickGuard }
}

/** Loaded only when the rail can persist a reorder of multiple projects. */
export default function SortableRailProjects({ projects, onReorder, renderProject }: RailProjectsProps) {
  const sorting = useRailSorting(projects, onReorder)
  return (
    <DndContext
      sensors={sorting.sensors}
      collisionDetection={closestCenter}
      measuring={RAIL_MEASURING}
      modifiers={[restrictToRailAxis]}
      accessibility={{ announcements: sorting.announcements, screenReaderInstructions: RAIL_INSTRUCTIONS }}
      onDragStart={sorting.onDragStart}
      onDragEnd={sorting.onDragEnd}
      onDragCancel={sorting.onDragCancel}
    >
      <SortableContext items={sorting.ids} strategy={verticalListSortingStrategy}>
        {sorting.projects.map((project, index) => (
          <SortableRailProject key={project.id} project={project} position={index + 1}
            total={sorting.projects.length} renderProject={renderProject} />
        ))}
      </SortableContext>
    </DndContext>
  )
}
