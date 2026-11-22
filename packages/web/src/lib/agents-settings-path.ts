/** Global Settings → Agents: install state, version and sign-in for every runner. It lives
 *  outside every project, so callers link to it with the plain react-router `Link`; the scoped
 *  `project-router` Link would prefix `/p/<id>` and mint a URL that is not a route. */
export const GLOBAL_AGENTS_PATH = '/settings/global/agents'

/** The element id of one runner's card on the global Agents page. */
export const agentCardId = (runner: string): string => `agent-${runner}`

/** A link straight to one runner's card on the global Agents page. */
export const agentCardPath = (runner: string): string => `${GLOBAL_AGENTS_PATH}#${agentCardId(runner)}`
