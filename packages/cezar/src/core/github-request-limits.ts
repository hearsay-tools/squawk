export const GITHUB_COMMAND_TIMEOUT_MS = 30_000;
/** Provider requests one history check may spend, its search included. */
export const HISTORY_REQUEST_CAP = 10;
/** The timeline is oldest first, so a live poll reads every page up to this cap. */
export const TIMELINE_PAGE_CAP = 10;
/** One scan can spend each provider request's full command timeout. */
export const GITHUB_POLL_TIMEOUT_MS = Math.max(HISTORY_REQUEST_CAP, TIMELINE_PAGE_CAP + 1) * GITHUB_COMMAND_TIMEOUT_MS;

// Two scans cover the canonical-name retry. One command budget covers discovery
// and queueing; that wait shares the total bound rather than extending it.
export const AUTOMATION_TOOL_TIMEOUT_MS = 2 * GITHUB_POLL_TIMEOUT_MS + GITHUB_COMMAND_TIMEOUT_MS;
// Let the server return its timeout diagnostic before the transport gives up.
export const AUTOMATION_TOOL_CLIENT_TIMEOUT_MS = AUTOMATION_TOOL_TIMEOUT_MS + GITHUB_COMMAND_TIMEOUT_MS;
