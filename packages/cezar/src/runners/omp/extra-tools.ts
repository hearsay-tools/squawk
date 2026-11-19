/** The OMP runner's extra tools: unioned onto the default list when a step does not set
 *  allowedTools. Data only: importing it loads no adapter. */
// R1 (rulings): find and ast_grep are gated behind settings that default off, and a --tools
// list naming an unavailable built-in exits 2, so they cannot be in the zero-config default.
export const OMP_EXTRA_TOOLS: readonly string[] = ['todo', 'lsp', 'ast_edit', 'task', 'wait'];
