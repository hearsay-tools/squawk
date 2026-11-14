/**
 * The `/new?skill=&ref=` prefill: the toast it shows and the text it writes when the named
 * skill is not installed here.
 */

/** The one toast a prefilled composer shows. `unknownSkill` is the skill param when it matches
 *  nothing installed here. */
export function prefillToast(unknownSkill: string): { message: string; tone: 'default' | 'danger' } {
  if (unknownSkill !== '') {
    return {
      message: `Unknown skill "${unknownSkill}" — prefilled for quick-task; review and press Start`,
      tone: 'danger',
    }
  }
  return { message: 'Prefilled from link — review and press Start', tone: 'default' }
}

/** The prefill for a skill the picker cannot select: the intent goes into the task text
 *  verbatim, and quick-task resolves it from prose. */
export function unknownSkillPrefillText(skill: string, ref: string): string {
  return `Use the "${skill}" skill on: ${ref}`
}
