/** The pi runner's extra tools: unioned onto the default list when a step does not set
 *  allowedTools. Data only: importing it loads no adapter. */
// The trio still marks the default list (hearsay-tools/cezarion#75). pi itself gets no --tools
// allowlist for it (hearsay-tools/cezarion#1305): the default-tools extension activates these
// names with the built-ins, so MCP and other extension tools stay callable.
export const PI_EXTRA_TOOLS: readonly string[] = ['Subagent', 'SubagentSupervisor', 'SubagentWait'];
