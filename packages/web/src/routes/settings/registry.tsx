import { BellIcon, BotIcon, FoldersIcon, GaugeIcon, KeyRoundIcon, PaletteIcon } from '@/components/design-icons'
import { FileCogIcon, FileStackIcon, FileTextIcon, FolderGit2Icon } from 'lucide-react'
import { lazy, type ComponentType, type SVGProps } from 'react'

const GlobalAgentsSection = lazy(() => import('./accounts-section').then((m) => ({ default: m.GlobalAgentsSection })))
const AgentConfigSection = lazy(() => import('./agent-config-section').then((m) => ({ default: m.AgentConfigSection })))
const AgentDefaultsSection = lazy(() => import('./agent-defaults-section').then((m) => ({ default: m.AgentDefaultsSection })))
const AppearanceSection = lazy(() => import('./appearance').then((m) => ({ default: m.AppearanceSection })))
const NotificationsSection = lazy(() => import('./notifications-section').then((m) => ({ default: m.NotificationsSection })))
const ProjectsSection = lazy(() => import('./projects-section').then((m) => ({ default: m.ProjectsSection })))
const PromptTemplatesSection = lazy(() => import('./prompt-templates-section').then((m) => ({ default: m.PromptTemplatesSection })))
const ResourcesSection = lazy(() => import('./resources-section').then((m) => ({ default: m.ResourcesSection })))
const SessionContextSection = lazy(() => import('./session-context-section').then((m) => ({ default: m.SessionContextSection })))
const SidebarSection = lazy(() => import('./sidebar-section').then((m) => ({ default: m.SidebarSection })))
const WorktreesSection = lazy(() => import('./worktrees-section').then((m) => ({ default: m.WorktreesSection })))

const TasksSection = lazy(() => import('./archive-on-merge-field').then((m) => ({ default: m.TasksSection })))

/**
 * The Settings section registry (R6 Step 1.3, spec §"Settings"): the ONE place a section is
 * declared. The shell renders the section nav and the routes from this list, so adding a
 * section later is one entry here — no layout work, no route wiring.
 *
 * Since the multi-project split (step 3.5, spec §"Settings split") every entry also declares
 * its `scope`, and that single field decides everything downstream — which URL the section
 * lives at (`/p/<id>/settings/<id>` vs `/settings/global/<id>`), which nav lists it, and which
 * store it writes. The rule of thumb: does the setting describe THIS REPO (agents, worktrees,
 * prompt templates) or the person/machine (appearance, notifications, host
 * resources, the project registry)?
 */

export type SettingsSectionId =
  | 'sidebar'
  | 'appearance'
  | 'agents'
  | 'agent-defaults'
  | 'agent-config'
  | 'session-context'
  | 'resources'
  | 'worktrees'
  | 'projects'
  | 'notifications'
  | 'prompt-templates'
  | 'tasks'

/** Which settings area a section belongs to — and therefore which store it writes. */
export type SettingsScope = 'project' | 'global'

export interface SettingsSection {
  id: SettingsSectionId
  title: string
  /** The one-liner under the title — the shell's desktop header and the index cards share it. */
  description: string
  icon: ComponentType<SVGProps<SVGSVGElement>>
  component: ComponentType
  /** `project` → `/p/<projectId>/settings/<id>`, `global` → `/settings/global/<id>`. */
  scope: SettingsScope
}

export const SETTINGS_SECTIONS: SettingsSection[] = [
  {
    id: 'sidebar',
    title: 'Sidebar',
    description: 'Overall and per-section task limits for this project.',
    icon: GaugeIcon,
    component: SidebarSection,
    scope: 'project',
  },
  // ---- project scope (`/p/<projectId>/settings/…`) — settings that describe THIS repo -------
  {
    id: 'agent-defaults',
    title: 'Agent defaults',
    description: 'Default runner, models and system prompt.',
    icon: BotIcon,
    component: AgentDefaultsSection,
    scope: 'project',
  },
  {
    id: 'agent-config',
    title: 'Agent config',
    description: 'Edit the coding agents’ own config files, per scope.',
    icon: FileCogIcon,
    component: AgentConfigSection,
    scope: 'project',
  },
  {
    id: 'session-context',
    title: 'Session context',
    description: 'Text Squawk puts at the start of every agent session it launches.',
    icon: FileStackIcon,
    component: SessionContextSection,
    scope: 'project',
  },
  {
    id: 'worktrees',
    title: 'Worktrees',
    description: 'How many finished task worktrees this project keeps on disk.',
    icon: FolderGit2Icon,
    component: WorktreesSection,
    scope: 'project',
  },
  {
    id: 'prompt-templates',
    title: 'Prompt templates',
    description: 'Reusable snippets for follow-up instructions.',
    icon: FileTextIcon,
    component: PromptTemplatesSection,
    scope: 'project',
  },
  // ---- global scope (`/settings/global/…`) — the user and the machine, in mockup order -----
  {
    id: 'appearance',
    title: 'Appearance',
    description: 'Theme, accent and density.',
    icon: PaletteIcon,
    component: AppearanceSection,
    scope: 'global',
  },
  {
    id: 'notifications',
    title: 'Notifications',
    description: 'Browser notifications when an agent needs you.',
    icon: BellIcon,
    component: NotificationsSection,
    scope: 'global',
  },
  {
    id: 'resources',
    title: 'Resources',
    description: 'Parallel tasks and per-task memory limit, across every project.',
    icon: GaugeIcon,
    component: ResourcesSection,
    scope: 'global',
  },
  { id: 'tasks', title: 'Tasks', description: 'Automatic task archiving after pull requests merge.', icon: FolderGit2Icon, component: TasksSection, scope: 'global' },
  {
    id: 'agents',
    title: 'Agents',
    description: 'Install, version and sign-in for each agent, and the agent and models a project uses when it has chosen none.',
    icon: KeyRoundIcon,
    component: GlobalAgentsSection,
    scope: 'global',
  },
  {
    id: 'projects',
    title: 'Projects',
    description: 'The workspace registry and where GitHub checkouts land.',
    icon: FoldersIcon,
    component: ProjectsSection,
    scope: 'global',
  },
]

/**
 * What one settings area's nav and route table actually show — only sections belonging to
 * that scope. The two areas use the same shell, so this filter keeps them apart.
 */
export function visibleSettingsSections(scope: SettingsScope): SettingsSection[] {
  return SETTINGS_SECTIONS.filter((section) => section.scope === scope)
}

/** Settings paths stay synchronous with the section metadata and route matcher. */
export function settingsSectionPath(scope: SettingsScope, id: SettingsSectionId): string {
  return scope === 'global' ? `/settings/global/${id}` : `/settings/${id}`
}

export const GLOBAL_SETTINGS_HOME = settingsSectionPath('global', 'appearance')
