import { child, type AstRule, type AstContext, type EsNode } from './ast-rule.ts';
import { namedMember, sameBoundary } from './twin-syntax.ts';

// automations-capability-read-outside-owner (hearsay-tools/squawk#3774).
const MESSAGE =
  "Ask the automations availability owner, packages/web/src/lib/capabilities.ts, instead of reading " +
  "`capabilities.automations`: `useAutomationsAvailable()` in a component, " +
  "`automationsAvailable(health)` where a health payload is already in hand, " +
  "`useAutomationsAvailability()` where \"not known yet\" needs its own state " +
  "(hearsay-tools/squawk#1401). A second reading drifts: the sidebar tab and the Tasks-page origin " +
  "filter showed Automations while the nav hid it.";

/** A type query and a JSX tag spell the same member access with different ESTree nodes. */
function namedAccess(node: EsNode, name: string, context: AstContext): boolean {
  if (node.type === 'MemberExpression') return namedMember(node, name, context);
  const field = node.type === 'TSQualifiedName' ? 'right' : 'property';
  const property = child(node, field);
  return (property?.type === 'Identifier' || property?.type === 'JSXIdentifier') && context.sourceCode.getText(property) === name;
}

function automationsAccess(node: EsNode, context: AstContext): boolean {
  if (!namedAccess(node, 'automations', context)) return false;
  const object = child(node, node.type === 'TSQualifiedName' ? 'left' : 'object');
  if (!object || !sameBoundary(node, object, 0, context)) return false;
  return ((object.type === 'Identifier' || object.type === 'JSXIdentifier') && context.sourceCode.getText(object) === 'capabilities') || namedAccess(object, 'capabilities', context);
}

function inTypeQuery(node: EsNode): boolean {
  let parent = node.parent;
  while (parent?.type === 'TSQualifiedName') parent = parent.parent;
  return parent?.type === 'TSTypeQuery';
}

/** Named member receivers only, without destructuring, computed keys, casts or parentheses. */
export const automationsCapabilityReadOutsideOwner: AstRule = {
  name: 'automations-capability-read-outside-owner',
  description: 'Ask the automations availability owner (hearsay-tools/squawk#1401)',
  applies: (file) => file.startsWith('packages/web/src/') && /\.tsx?$/.test(file) && file !== 'packages/web/src/lib/capabilities.ts' && !/\.(?:test|testkit)\.tsx?$/.test(file),
  create: (report, context) => ({
    MemberExpression(node) {
      if (automationsAccess(node, context)) report(node, MESSAGE);
    },
    TSQualifiedName(node) {
      if (inTypeQuery(node) && child(node, 'left')?.type === 'Identifier' && automationsAccess(node, context)) report(node, MESSAGE);
    },
    JSXMemberExpression(node) {
      if (automationsAccess(node, context)) report(node, MESSAGE);
    },
  }),
};
