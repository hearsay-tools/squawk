import { SkillOptionLabel } from '@/components/skill-option-label'
import type { RunnerSkill } from '@open-mercato/cezar-api-client/contract/runner-skills'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { CheckIcon, ChevronDownIcon, NotebookPenIcon, PlusIcon, SparklesIcon, Trash2Icon, XIcon } from '@/components/design-icons'

import { useRef, useState, type ReactNode } from 'react'

import { putUiState } from '@/api/client'
import { queryKeys, useRunnerSkills, useUiState } from '@/api/queries'
import { CenteredState } from '@/components/centered-state'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Textarea } from '@/components/ui/textarea'
import { toast } from '@/components/ui/toaster'
import {
  DEFAULT_PROMPT_TEMPLATES,
  makeTemplateId,
  normalizePromptTemplates,
  type PromptTemplate,
} from '@/lib/prompt-templates'
import { isProjectSkill, searchSkillsForDisplay, skillKeywords, skillKey } from '@/lib/skills'
import { cn } from '@/lib/utils'
import { useUnsentDraft } from '@/lib/version-reload'
import { sameJson, useSavedDraft } from '@/lib/saved-draft'
import { SaveRow } from './save-cue'

/**
 * Settings → Prompt templates (#413): "add the settings pane for editing these prompt templates
 * so I can make sure it always start as I wanted" — the issue's own words. The list here is
 * exactly the one task creation and GitHub hand-over read
 * (`PromptTemplateMenu` / `normalizePromptTemplates`), so an edit here reshapes both at once.
 *
 * Zero-config: an untouched repo shows `DEFAULT_PROMPT_TEMPLATES` with nothing persisted yet.
 * The first Save writes the full (possibly edited-in-place) list to `ui-state.json`'s additive
 * `promptTemplates` key — same "edit locally, explicit Save" shape as Settings → Agent defaults' system
 * prompt, because a PUT on every keystroke would be a worse control, not a simpler one.
 */
export function PromptTemplatesSection() {
  const uiState = useUiState()

  if (uiState.isPending) {
    return (
      <p data-slot="prompt-templates-loading" className="p-4 text-[13px] text-soft-foreground md:p-6">
        Loading prompt templates…
      </p>
    )
  }
  if (uiState.isError) {
    return (
      <CenteredState
        icon={<NotebookPenIcon />}
        tone="danger"
        title="Prompt templates did not load"
        subtitle={uiState.error.message}
        heading="h2"
      />
    )
  }
  // Keyed on whether the server has ever written this key: an untouched repo (undefined) and an
  // explicitly-cleared one ([]) both come through `normalizePromptTemplates` correctly already,
  // so the form below never has to know the difference.
  return <PromptTemplatesForm initial={normalizePromptTemplates(uiState.data.promptTemplates)} />
}

function PromptTemplatesForm({ initial }: { initial: PromptTemplate[] }) {
  const queryClient = useQueryClient()
  const skills = useRunnerSkills()
  // Already cached by the section gate above; read again here for the picker's #519 tiers.
  const uiState = useUiState()
  const [templates, setTemplates] = useSavedDraft<PromptTemplate[]>(initial, sameJson)
  const [newLabel, setNewLabel] = useState('')
  const [newText, setNewText] = useState('')

  const save = useMutation({
    mutationFn: (next: PromptTemplate[]) => putUiState({ promptTemplates: next }),
    onSuccess: (merged, submitted) => {
      queryClient.setQueryData(queryKeys.uiState, merged)
      // The server stores the normalized list (trimmed text); hold that, so a save never leaves
      // whitespace the form counts as an unsaved edit. Edits made while the save was pending stay.
      setTemplates((current) =>
        sameJson(current, submitted) ? normalizePromptTemplates(merged.promptTemplates) : current,
      )
      toast('Prompt templates saved')
    },
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })

  const dirty = JSON.stringify(templates) !== JSON.stringify(initial)
  const hasNewDraft = newLabel.trim() !== '' || newText.trim() !== ''
  useUnsentDraft(dirty || hasNewDraft)
  const invalid = templates.some((t) => t.label.trim() === '' || t.text.trim() === '')

  const updateTemplate = (id: string, patch: Partial<Pick<PromptTemplate, 'label' | 'text'>>) =>
    setTemplates((current) => current.map((t) => (t.id === id ? { ...t, ...patch } : t)))

  /** Assign/unassign a skill. Unassigning the last one DROPS the key rather than leaving `[]`,
   *  matching what `normalizePromptTemplates` produces — otherwise assign-then-unassign would
   *  leave the form permanently "dirty" against an `initial` that never had the key. */
  const toggleTemplateSkill = (id: string, name: string) =>
    setTemplates((current) =>
      current.map((template) => {
        if (template.id !== id) return template
        const assigned = template.skills ?? []
        const next = assigned.includes(name)
          ? assigned.filter((existing) => existing !== name)
          : [...assigned, name]
        const { skills: _previous, ...rest } = template
        return next.length > 0 ? { ...rest, skills: next } : rest
      }),
    )

  const removeTemplate = (id: string) =>
    setTemplates((current) => current.filter((t) => t.id !== id))

  const addTemplate = () => {
    const label = newLabel.trim()
    const text = newText.trim()
    if (!label || !text) return
    setTemplates((current) => [...current, { id: makeTemplateId(), label, text }])
    setNewLabel('')
    setNewText('')
  }

  const resetToDefaults = () => setTemplates(DEFAULT_PROMPT_TEMPLATES.map((t) => ({ ...t })))

  return (
    <div
      data-slot="prompt-templates-section"
      data-reports-dirty=""
      className="mx-auto flex w-full max-w-2xl flex-col gap-7 p-4 pb-[calc(90px+env(safe-area-inset-bottom))] md:p-6 md:pb-6"
    >
      <Field
        title="Reusable instructions"
        hint="Insert templates from task composers, or apply them automatically with selected skills when the prompt is empty."
      >
        <div data-slot="prompt-template-list" className="flex flex-col gap-3">
          {templates.length === 0 ? (
            <p data-slot="prompt-templates-empty" className="text-[13px] text-soft-foreground">
              No templates. Add one below, or reset to the built-ins.
            </p>
          ) : (
            templates.map((template) => (
              <div
                key={template.id}
                data-slot="prompt-template-row"
                data-template={template.id}
                className="flex flex-col gap-1.5 rounded-md border border-border bg-card p-3"
              >
                <div className="flex flex-col gap-2">
                  <label htmlFor={`template-label-${template.id}`} className="text-sm">Template label</label>
                  <Input
                    id={`template-label-${template.id}`}
                    aria-label={`Label for ${template.label || 'this template'}`}
                    data-slot="prompt-template-label-input"
                    value={template.label}
                    maxLength={80}
                    onChange={(event) => updateTemplate(template.id, { label: event.target.value })}
                    // The label and the instructions share one border and fill, so they read as one form pair.
                    className="flex-1 border-control-border bg-background"
                  />

                </div>
                <label htmlFor={`template-text-${template.id}`} className="text-sm">Instructions</label>
                <Textarea
                  id={`template-text-${template.id}`}
                  aria-label={`Text for ${template.label || 'this template'}`}
                  data-slot="prompt-template-text-input"
                  value={template.text}
                  maxLength={2000}
                  onChange={(event) => updateTemplate(template.id, { text: event.target.value })}
                  className="min-h-14 rounded-md border border-control-border bg-background text-[13px]"
                />
                <p className="text-sm">Apply automatically with skills</p>
                <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                  <TemplateSkillsPicker
                    label={template.label}
                    skills={skills.data ?? []}
                    skillUsage={uiState.data?.skillUsage}
                    selected={template.skills ?? []}
                    onToggle={(name) => toggleTemplateSkill(template.id, name)}
                  />
                  {/* Chips live OUTSIDE the dropdown — the house rule from the GitHub picker:
                      cmdk may filter the list, never your selection. */}
                  {(template.skills ?? []).map((name) => (
                    <button
                      key={name}
                      type="button"
                      data-slot="prompt-template-skill-chip"
                      data-skill={name}
                      title={`Stop applying “${template.label}” automatically with ${name}`}
                      onClick={() => toggleTemplateSkill(template.id, name)}
                      className="inline-flex items-center gap-1 rounded-md border border-border bg-muted px-2 py-0.5 font-mono text-xs font-medium text-foreground transition-colors hover:bg-danger/10 hover:text-danger"
                    >
                      {name}
                      <XIcon aria-hidden="true" className="size-3" />
                    </button>
                  ))}
                </div>
                  <Button
                    type="button"
                    className="self-start"
                    variant="danger-ghost"
                    size="sm"
                    data-action="prompt-template-remove"
                    title="Remove this template"
                    onClick={() => removeTemplate(template.id)}
                  >
                    <Trash2Icon aria-hidden="true" className="size-3" />
                    Delete template
                  </Button>
              </div>
            ))
          )}
        </div>

        <div
          data-slot="prompt-template-new"
          className="flex flex-col gap-1.5 rounded-md border border-dashed border-border p-3"
        >
          <h3 className="text-lg">New template</h3>
          <label htmlFor="new-template-label" className="text-sm">Label</label>
          <Input
            id="new-template-label"
            aria-label="New template label"
            data-slot="prompt-template-new-label"
            placeholder="e.g. Review security"
            value={newLabel}
            maxLength={80}
            onChange={(event) => setNewLabel(event.target.value)}
            className="border-control-border bg-background"
          />
          <label htmlFor="new-template-text" className="text-sm">Instructions to insert</label>
          <Textarea
            id="new-template-text"
            aria-label="New template text"
            data-slot="prompt-template-new-text"
            placeholder="Enter reusable instructions…"
            value={newText}
            maxLength={2000}
            onChange={(event) => setNewText(event.target.value)}
            className="min-h-14 rounded-md border border-control-border bg-background text-[13px]"
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-action="prompt-template-add"
            disabled={!newLabel.trim() || !newText.trim()}
            onClick={addTemplate}
            className="self-start"
          >
            <PlusIcon aria-hidden="true" className="size-3.5" />
            Add template
          </Button>
        </div>

        <div className="flex items-center gap-3">
          <SaveRow show={!dirty && !invalid && !save.isPending}>
            <Button
              type="button"
              variant="primary"
              size="sm"
              data-action="prompt-templates-save"
              disabled={!dirty || invalid || save.isPending}
              onClick={() => save.mutate(templates)}
            >
              Save
            </Button>
          </SaveRow>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-action="prompt-templates-reset"
            disabled={save.isPending}
            onClick={resetToDefaults}
          >
            Reset to defaults
          </Button>
          {invalid ? (
            <p data-slot="prompt-templates-invalid" className="text-[11px] text-danger">
              Every template needs both a label and text.
            </p>
          ) : null}
        </div>
      </Field>
    </div>
  )
}

/**
 * "Apply automatically with…" — assigns a template to skills. Multi-select (toggling keeps the
 * popover open, because wiring a template to a few skills is several toggles), searchable, and
 * grouped Project-first (#377) — the same cmdk grammar as the GitHub hand-over's skills picker,
 * so this reads as the same control rather than a second dialect of it.
 *
 * Renders a disabled trigger, not nothing, when no skills are discovered: "there are no skills to
 * assign to" is worth saying out loud in a Settings pane whose whole subject is the assignment.
 */
function TemplateSkillsPicker({
  label,
  skills,
  skillUsage,
  selected,
  onToggle,
}: {
  label: string
  skills: readonly RunnerSkill[]
  skillUsage: Readonly<Record<string, number>> | undefined
  selected: readonly string[]
  onToggle: (name: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  const { mostUsed, project, global, ranked } = searchSkillsForDisplay(skills, search, skillUsage)

  const skillItem = (skill: RunnerSkill, emphasized: boolean) => {
    const isSelected = selected.includes(skill.id)
    return (
      <CommandItem
        key={skillKey(skill)}
        value={skillKey(skill)}
        keywords={skillKeywords(skill.name, skill.description)}
        data-slot="prompt-template-skill-option"
        data-skill={skill.id}
        data-selected={isSelected ? 'true' : undefined}
        onSelect={() => onToggle(skill.id)}
      >
        <SkillOptionLabel skill={skill} emphasized={emphasized} />
        {isSelected ? (
          <CheckIcon aria-hidden="true" className="ml-auto size-3.5 shrink-0 text-link-foreground" />
        ) : null}
      </CommandItem>
    )
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setSearch('')
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          data-slot="prompt-template-skills-trigger"
          aria-label={`Apply ${label || 'this template'} automatically with a skill`}
          title="Pick the skills this template applies itself to"
          className={cn(
            'inline-flex h-[26px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-border bg-card px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50',
            selected.length > 0 && 'text-foreground',
          )}
        >
          <SparklesIcon aria-hidden="true" className="size-3 shrink-0 text-accent-icon" />
          Add skill
          <ChevronDownIcon aria-hidden="true" className="size-2.5 shrink-0 text-soft-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={8} className="w-[336px] max-w-[calc(100vw-2rem)] p-0">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="search skills…"
            value={search}
            onValueChange={setSearch}
            onInput={() => listRef.current?.scrollTo(0, 0)}
          />
          <CommandList
            ref={listRef}
            data-slot="prompt-template-skill-menu"
            className="max-h-[min(16rem,calc(var(--radix-popover-content-available-height)-3rem))]"
          >
            {search.trim() && !skills.some((skill) => skill.id === search.trim()) ? <CommandGroup><CommandItem value="typed-skill" onSelect={() => onToggle(search.trim())}>Use skill id “{search.trim()}” (unchecked)</CommandItem></CommandGroup> : null}
            {(ranked ? ranked.length === 0 : mostUsed.length === 0 && project.length === 0 && global.length === 0) ? (
              <CommandEmpty>Nothing matches.</CommandEmpty>
            ) : null}
            {ranked ? (
              ranked.length > 0 ? (
                <CommandGroup>
                  {ranked.map((skill) => skillItem(skill, isProjectSkill(skill)))}
                </CommandGroup>
              ) : null
            ) : (
              <>
                {mostUsed.length > 0 ? (
                  <CommandGroup heading="Most used">
                    {mostUsed.map((skill) => skillItem(skill, isProjectSkill(skill)))}
                  </CommandGroup>
                ) : null}
                {project.length > 0 ? (
                  <CommandGroup heading="Project skills">
                    {project.map((skill) => skillItem(skill, true))}
                  </CommandGroup>
                ) : null}
                {global.length > 0 ? (
                  <CommandGroup heading="Global">{global.map((skill) => skillItem(skill, false))}</CommandGroup>
                ) : null}
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

/** The Appearance/Agents sections' field chassis — same rhythm, so Settings reads as one surface. */
function Field({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  return (
    <section className="settings-field flex flex-col gap-2">
      <div>
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        <p className="text-[13px] text-muted-foreground">{hint}</p>
      </div>
      {children}
    </section>
  )
}
