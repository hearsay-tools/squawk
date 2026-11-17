import { child, type AstRule, type AstContext, type EsNode } from './ast-rule.ts';
import { sameBoundary } from './twin-syntax.ts';

// subagent-children-outside-dock (hearsay-tools/squawk#3774).
const MESSAGE =
  "Read a subagent's children through `subagentEntries(visibleTurns, currentTurns, id)` in " +
  "packages/web/src/routes/task-thread/subagent-dock.ts (hearsay-tools/squawk#2463). The " +
  "current-state context drops a subagent's messages; `subagentEntries` adds them from the loaded " +
  "transcript, so the sheet and the dock row show the same entries. `subagentChildren` reads one " +
  "view only.";

function directName(node: EsNode, field: string, context: AstContext): boolean {
  const callee = child(node, field);
  return callee?.type === 'Identifier' && context.sourceCode.getText(callee) === 'subagentChildren' && sameBoundary(node, callee, 0, context);
}

/** Only a direct call to the exact public name; import aliases and member calls stay out. */
export const subagentChildrenOutsideDock: AstRule = {
  name: 'subagent-children-outside-dock',
  description: 'Read merged subagent entries through the dock (hearsay-tools/squawk#2463)',
  applies: (file) => file.startsWith('packages/web/src/') && /\.tsx?$/.test(file) && file !== 'packages/web/src/routes/task-thread/subagent-dock.ts' && !/\.test\.tsx?$/.test(file),
  create: (report, context) => ({
    CallExpression(node) {
      if (directName(node, 'callee', context)) report(node, MESSAGE);
    },
    TaggedTemplateExpression(node) {
      // Tree-sitter also calls a plain template tag a call_expression, but a generic tag's
      // function is a generic_function rather than the exact name.
      if (!node.typeArguments && directName(node, 'tag', context)) report(node, MESSAGE);
    },
  }),
};
