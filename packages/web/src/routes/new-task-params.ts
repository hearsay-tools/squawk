import type { Runner } from '@open-mercato/cezar-api-client'
import type { RunnersResponse } from '@open-mercato/cezar-api-client/contract/runners'

/** The `/new` prefill query: `?skill=&ref=`. `ref` falls back to the older `task` spelling.
 *  Parsing lives apart from the component so it stays table-testable. */
export interface NewTaskParams {
  skill: string
  skillPath?: string
  /** A picker's explicit runner replaces the saved draft identity. Omitted account
   * follows that runner's project default. Links without a runner keep draft choices. */
  runner?: Runner
  account?: string
  ref: string
}

/** `runner` is kept only when the runners list names it; until the list answers, it is absent. */
export function parseNewTaskParams(
  search: string | URLSearchParams,
  runners: RunnersResponse | undefined,
): NewTaskParams {
  const params = typeof search === 'string' ? new URLSearchParams(search) : search
  const runner = params.get('runner')
  const registered = runner !== null && (runners?.runners.some((entry) => entry.id === runner) ?? false)
  const skillPath = params.get('skillPath')
  return {
    skill: (params.get('skill') ?? '').trim(),
    ...(skillPath ? { skillPath } : {}),
    ...(registered ? { runner } : {}),
    ...(params.has('account') ? { account: params.get('account')! } : {}),
    ref: (params.get('ref') ?? params.get('task') ?? '').trim(),
  }
}

/** Build a same-origin `/new` href from this contract — the counterpart to `parseNewTaskParams`
 *  for in-app callers. */
export function newTaskPrefillHref(params: {
  skill?: string | undefined
  skillPath?: string | undefined
  runner?: Runner
  account?: string
  ref?: string
}): string {
  const search = new URLSearchParams()
  if (params.skill) search.set('skill', params.skill)
  if (params.skillPath !== undefined) search.set('skillPath', params.skillPath)
  if (params.runner) search.set('runner', params.runner)
  if (params.account !== undefined) search.set('account', params.account)
  if (params.ref) search.set('ref', params.ref)
  const qs = search.toString()
  return qs ? `/new?${qs}` : '/new'
}
