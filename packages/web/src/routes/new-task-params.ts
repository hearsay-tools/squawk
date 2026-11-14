/** The `/new` prefill query: `?skill=&ref=`. `ref` falls back to the older `task` spelling.
 *  Parsing lives apart from the component so it stays table-testable. */
export interface NewTaskParams {
  skill: string
  ref: string
}

export function parseNewTaskParams(search: string | URLSearchParams): NewTaskParams {
  const params = typeof search === 'string' ? new URLSearchParams(search) : search
  return {
    skill: (params.get('skill') ?? '').trim(),
    ref: (params.get('ref') ?? params.get('task') ?? '').trim(),
  }
}

/** Build a same-origin `/new` href from this contract — the counterpart to `parseNewTaskParams`
 *  for in-app callers. */
export function newTaskPrefillHref(params: { skill?: string | undefined; ref?: string }): string {
  const search = new URLSearchParams()
  if (params.skill) search.set('skill', params.skill)
  if (params.ref) search.set('ref', params.ref)
  const qs = search.toString()
  return qs ? `/new?${qs}` : '/new'
}
