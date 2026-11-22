import { forwardRef, type ReactNode, type Ref, type SVGProps } from 'react'
import * as glyphs from './design-icons/glyphs'
import type { DesignIconGlyph } from './design-icons/glyphs'

/** Exact filled glyph outlines from the approved 193-frame cezarion.pen export.
 * Source SHA256: 56a71a27c7795137cab1c0a40a5839edecbacab4014d2d39ddc90f89343275f8.
 * These preserve the exported font geometry; they are not stroked Lucide substitutes.
 * Glyphs live in design-icons/glyphs*.ts, one export each, so unused icons tree-shake.
 */
const glyphByName = {
  'menu': glyphs.menuGlyph, 'folder': glyphs.folderGlyph, 'chevron-down': glyphs.chevronDownGlyph,
  'terminal': glyphs.terminalGlyph, 'paperclip': glyphs.paperclipGlyph, 'notebook-pen': glyphs.notebookPenGlyph,
  'sparkles': glyphs.sparklesGlyph, 'mic': glyphs.micGlyph, 'check': glyphs.checkGlyph,
  'cpu': glyphs.cpuGlyph, 'gauge': glyphs.gaugeGlyph, 'chevron-up': glyphs.chevronUpGlyph,
  'arrow-up': glyphs.arrowUpGlyph, 'shield-check': glyphs.shieldCheckGlyph, 'search': glyphs.searchGlyph,
  'plus': glyphs.plusGlyph, 'folder-open': glyphs.folderOpenGlyph, 'list-todo': glyphs.listTodoGlyph,
  'git-branch': glyphs.gitBranchGlyph, 'github': glyphs.githubGlyph, 'workflow': glyphs.workflowGlyph,
  'settings': glyphs.settingsGlyph, 'git-merge': glyphs.gitMergeGlyph, 'pin': glyphs.pinGlyph,
  'git-pull-request': glyphs.gitPullRequestGlyph, 'circle-dot': glyphs.circleDotGlyph, 'layers': glyphs.layersGlyph,
  'folder-plus': glyphs.folderPlusGlyph, 'settings-2': glyphs.settings2Glyph, 'wrench': glyphs.wrenchGlyph,
  'sun-moon': glyphs.sunMoonGlyph, 'sliders-horizontal': glyphs.slidersHorizontalGlyph, 'chevron-right': glyphs.chevronRightGlyph,
  'circle-check': glyphs.circleCheckGlyph, 'bot': glyphs.botGlyph, 'refresh-cw': glyphs.refreshCwGlyph,
  'file-code': glyphs.fileCodeGlyph, 'git-commit-horizontal': glyphs.gitCommitHorizontalGlyph, 'palette': glyphs.paletteGlyph,
  'download': glyphs.downloadGlyph, 'zap': glyphs.zapGlyph, 'x': glyphs.xGlyph,
  'ellipsis': glyphs.ellipsisGlyph, 'messages-square': glyphs.messagesSquareGlyph, 'archive': glyphs.archiveGlyph,
  'arrow-up-right': glyphs.arrowUpRightGlyph, 'align-left': glyphs.alignLeftGlyph, 'columns-2': glyphs.columns2Glyph,
  'tags': glyphs.tagsGlyph, 'users': glyphs.usersGlyph, 'square': glyphs.squareGlyph,
  'list': glyphs.listGlyph, 'upload': glyphs.uploadGlyph, 'wand-sparkles': glyphs.wandSparklesGlyph,
  'trash-2': glyphs.trash2Glyph, 'arrow-down': glyphs.arrowDownGlyph, 'copy': glyphs.copyGlyph,
  'bell': glyphs.bellGlyph, 'key-round': glyphs.keyRoundGlyph, 'folders': glyphs.foldersGlyph,
  'file-diff': glyphs.fileDiffGlyph, 'file-search': glyphs.fileSearchGlyph, 'triangle-alert': glyphs.triangleAlertGlyph,
  'circle': glyphs.circleGlyph, 'circle-x': glyphs.circleXGlyph, 'git-pull-request-draft': glyphs.gitPullRequestDraftGlyph,
  'message-square-warning': glyphs.messageSquareWarningGlyph, 'git-pull-request-closed': glyphs.gitPullRequestClosedGlyph, 'circle-slash': glyphs.circleSlashGlyph,
  'arrow-right': glyphs.arrowRightGlyph, 'grip-vertical': glyphs.gripVerticalGlyph, 'arrow-left': glyphs.arrowLeftGlyph,
  'minus': glyphs.minusGlyph, 'square-check': glyphs.squareCheckGlyph, 'user-round': glyphs.userRoundGlyph,
  'inbox': glyphs.inboxGlyph,
} satisfies Record<string, DesignIconGlyph>
export type DesignIconName = keyof typeof glyphByName
export type DesignIconProps = SVGProps<SVGSVGElement> & { size?: number | string }

function renderGlyph(name: DesignIconName, glyph: DesignIconGlyph, { size = 24, children, ...props }: DesignIconProps, ref: Ref<SVGSVGElement>): ReactNode {
  const labelled = Boolean(props['aria-label'] || props['aria-labelledby'])
  return <svg ref={ref} width={size} height={size} viewBox={glyph.viewBox}
    aria-hidden={labelled ? undefined : true} role={labelled ? 'img' : undefined}
    focusable="false" {...props} fill="currentColor" stroke="none" data-design-icon={name}>
    {glyph.paths.map((path, index) => <path key={index} d={path.d} />)}
    {children}
  </svg>
}

export const DesignIcon = /*#__PURE__*/ forwardRef<SVGSVGElement, DesignIconProps & { name: DesignIconName }>(
  function DesignIcon({ name, ...props }, ref) {
    return renderGlyph(name, glyphByName[name], props, ref)
  },
)

function icon(name: DesignIconName, glyph: DesignIconGlyph) {
  const Component = forwardRef<SVGSVGElement, DesignIconProps>((props, ref) => renderGlyph(name, glyph, props, ref))
  Component.displayName = `DesignIcon(${name})`
  return Component
}

export const MenuIcon = /*#__PURE__*/ icon('menu', glyphs.menuGlyph)
export const FolderIcon = /*#__PURE__*/ icon('folder', glyphs.folderGlyph)
export const ChevronDownIcon = /*#__PURE__*/ icon('chevron-down', glyphs.chevronDownGlyph)
export const TerminalIcon = /*#__PURE__*/ icon('terminal', glyphs.terminalGlyph)
export const PaperclipIcon = /*#__PURE__*/ icon('paperclip', glyphs.paperclipGlyph)
export const NotebookPenIcon = /*#__PURE__*/ icon('notebook-pen', glyphs.notebookPenGlyph)
export const SparklesIcon = /*#__PURE__*/ icon('sparkles', glyphs.sparklesGlyph)
export const MicIcon = /*#__PURE__*/ icon('mic', glyphs.micGlyph)
export const CheckIcon = /*#__PURE__*/ icon('check', glyphs.checkGlyph)
export const CpuIcon = /*#__PURE__*/ icon('cpu', glyphs.cpuGlyph)
export const GaugeIcon = /*#__PURE__*/ icon('gauge', glyphs.gaugeGlyph)
export const ChevronUpIcon = /*#__PURE__*/ icon('chevron-up', glyphs.chevronUpGlyph)
export const ArrowUpIcon = /*#__PURE__*/ icon('arrow-up', glyphs.arrowUpGlyph)
export const ShieldCheckIcon = /*#__PURE__*/ icon('shield-check', glyphs.shieldCheckGlyph)
export const SearchIcon = /*#__PURE__*/ icon('search', glyphs.searchGlyph)
export const PlusIcon = /*#__PURE__*/ icon('plus', glyphs.plusGlyph)
export const FolderOpenIcon = /*#__PURE__*/ icon('folder-open', glyphs.folderOpenGlyph)
export const ListTodoIcon = /*#__PURE__*/ icon('list-todo', glyphs.listTodoGlyph)
export const GitBranchIcon = /*#__PURE__*/ icon('git-branch', glyphs.gitBranchGlyph)
export const GithubIcon = /*#__PURE__*/ icon('github', glyphs.githubGlyph)
export const WorkflowIcon = /*#__PURE__*/ icon('workflow', glyphs.workflowGlyph)
export const SettingsIcon = /*#__PURE__*/ icon('settings', glyphs.settingsGlyph)
export const GitMergeIcon = /*#__PURE__*/ icon('git-merge', glyphs.gitMergeGlyph)
export const PinIcon = /*#__PURE__*/ icon('pin', glyphs.pinGlyph)
export const GitPullRequestIcon = /*#__PURE__*/ icon('git-pull-request', glyphs.gitPullRequestGlyph)
export const CircleDotIcon = /*#__PURE__*/ icon('circle-dot', glyphs.circleDotGlyph)
export const LayersIcon = /*#__PURE__*/ icon('layers', glyphs.layersGlyph)
export const FolderPlusIcon = /*#__PURE__*/ icon('folder-plus', glyphs.folderPlusGlyph)
export const Settings2Icon = /*#__PURE__*/ icon('settings-2', glyphs.settings2Glyph)
export const WrenchIcon = /*#__PURE__*/ icon('wrench', glyphs.wrenchGlyph)
export const SunMoonIcon = /*#__PURE__*/ icon('sun-moon', glyphs.sunMoonGlyph)
export const SlidersHorizontalIcon = /*#__PURE__*/ icon('sliders-horizontal', glyphs.slidersHorizontalGlyph)
export const ChevronRightIcon = /*#__PURE__*/ icon('chevron-right', glyphs.chevronRightGlyph)
export const CircleCheckIcon = /*#__PURE__*/ icon('circle-check', glyphs.circleCheckGlyph)
export const BotIcon = /*#__PURE__*/ icon('bot', glyphs.botGlyph)
export const RefreshCwIcon = /*#__PURE__*/ icon('refresh-cw', glyphs.refreshCwGlyph)
export const FileCodeIcon = /*#__PURE__*/ icon('file-code', glyphs.fileCodeGlyph)
export const GitCommitHorizontalIcon = /*#__PURE__*/ icon('git-commit-horizontal', glyphs.gitCommitHorizontalGlyph)
export const PaletteIcon = /*#__PURE__*/ icon('palette', glyphs.paletteGlyph)
export const DownloadIcon = /*#__PURE__*/ icon('download', glyphs.downloadGlyph)
export const ZapIcon = /*#__PURE__*/ icon('zap', glyphs.zapGlyph)
export const XIcon = /*#__PURE__*/ icon('x', glyphs.xGlyph)
export const EllipsisIcon = /*#__PURE__*/ icon('ellipsis', glyphs.ellipsisGlyph)
export const MessagesSquareIcon = /*#__PURE__*/ icon('messages-square', glyphs.messagesSquareGlyph)
export const ArchiveIcon = /*#__PURE__*/ icon('archive', glyphs.archiveGlyph)
export const ArrowUpRightIcon = /*#__PURE__*/ icon('arrow-up-right', glyphs.arrowUpRightGlyph)
export const AlignLeftIcon = /*#__PURE__*/ icon('align-left', glyphs.alignLeftGlyph)
export const Columns2Icon = /*#__PURE__*/ icon('columns-2', glyphs.columns2Glyph)
export const TagsIcon = /*#__PURE__*/ icon('tags', glyphs.tagsGlyph)
export const UsersIcon = /*#__PURE__*/ icon('users', glyphs.usersGlyph)
export const SquareIcon = /*#__PURE__*/ icon('square', glyphs.squareGlyph)
export const ListIcon = /*#__PURE__*/ icon('list', glyphs.listGlyph)
export const UploadIcon = /*#__PURE__*/ icon('upload', glyphs.uploadGlyph)
export const WandSparklesIcon = /*#__PURE__*/ icon('wand-sparkles', glyphs.wandSparklesGlyph)
export const Trash2Icon = /*#__PURE__*/ icon('trash-2', glyphs.trash2Glyph)
export const ArrowDownIcon = /*#__PURE__*/ icon('arrow-down', glyphs.arrowDownGlyph)
export const CopyIcon = /*#__PURE__*/ icon('copy', glyphs.copyGlyph)
export const BellIcon = /*#__PURE__*/ icon('bell', glyphs.bellGlyph)
export const KeyRoundIcon = /*#__PURE__*/ icon('key-round', glyphs.keyRoundGlyph)
export const FoldersIcon = /*#__PURE__*/ icon('folders', glyphs.foldersGlyph)
export const FileDiffIcon = /*#__PURE__*/ icon('file-diff', glyphs.fileDiffGlyph)
export const FileSearchIcon = /*#__PURE__*/ icon('file-search', glyphs.fileSearchGlyph)
export const TriangleAlertIcon = /*#__PURE__*/ icon('triangle-alert', glyphs.triangleAlertGlyph)
export const CircleIcon = /*#__PURE__*/ icon('circle', glyphs.circleGlyph)
export const CircleXIcon = /*#__PURE__*/ icon('circle-x', glyphs.circleXGlyph)
export const GitPullRequestDraftIcon = /*#__PURE__*/ icon('git-pull-request-draft', glyphs.gitPullRequestDraftGlyph)
export const MessageSquareWarningIcon = /*#__PURE__*/ icon('message-square-warning', glyphs.messageSquareWarningGlyph)
export const GitPullRequestClosedIcon = /*#__PURE__*/ icon('git-pull-request-closed', glyphs.gitPullRequestClosedGlyph)
export const CircleSlashIcon = /*#__PURE__*/ icon('circle-slash', glyphs.circleSlashGlyph)
export const ArrowRightIcon = /*#__PURE__*/ icon('arrow-right', glyphs.arrowRightGlyph)
export const GripVerticalIcon = /*#__PURE__*/ icon('grip-vertical', glyphs.gripVerticalGlyph)
export const ArrowLeftIcon = /*#__PURE__*/ icon('arrow-left', glyphs.arrowLeftGlyph)
export const MinusIcon = /*#__PURE__*/ icon('minus', glyphs.minusGlyph)
export const SquareCheckIcon = /*#__PURE__*/ icon('square-check', glyphs.squareCheckGlyph)
export const UserRoundIcon = /*#__PURE__*/ icon('user-round', glyphs.userRoundGlyph)
