import type { AutomationEvent } from '@open-mercato/cezar-api-client/contract/automations'

/** What happens on GitHub, as the clause after "When". */
const EVENT_CLAUSE: Record<AutomationEvent, string> = {
  'pull_request.opened': 'a pull request opens',
  'issue.opened': 'an issue opens',
  'issue.labeled': 'an issue is labeled',
  'issue.unlabeled': 'an issue is unlabeled',
}

/** The editor's event chip words: short, sentence case, no machine identifier. */
export const EVENT_CHIP_LABEL: Record<AutomationEvent, string> = {
  'pull_request.opened': 'Pull request opened',
  'issue.opened': 'Issue opened',
  'issue.labeled': 'Issue labeled',
  'issue.unlabeled': 'Issue unlabeled',
}

/** "When a pull request opens", "When an issue opens or an issue is labeled", … */
export function eventsSentence(events: readonly AutomationEvent[]): string {
  const clauses = events.map((event) => EVENT_CLAUSE[event])
  if (clauses.length === 0) return 'When GitHub changes'
  const head = clauses.slice(0, -1)
  const last = clauses[clauses.length - 1]
  return `When ${head.length > 0 ? `${head.join(', ')} or ${last}` : last}`
}
