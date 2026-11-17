import { child, type AstRule } from './ast-rule.ts';
import { namedMember, sameBoundary } from './twin-syntax.ts';

// automations-capability-read-outside-owner (hearsay-tools/squawk#3774).
const MESSAGE =
  "Ask the automations availability owner, packages/web/src/lib/capabilities.ts, instead of reading " +
  "`capabilities.automations`: `useAutomationsAvailable()` in a component, " +
  "`automationsAvailable(health)` where a health payload is already in hand, " +
  "`useAutomationsAvailability()` where \"not known yet\" needs its own state " +
  "(hearsay-tools/squawk#1401). A second reading drifts: the sidebar tab and the Tasks-page origin " +
  "filter showed Automations while the nav hid it.";

/** Named member receivers only, without destructuring, computed keys, casts or parentheses. */
export const automationsCapabilityReadOutsideOwner: AstRule = {
  name: 'automations-capability-read-outside-owner',
  description: 'Ask the automations availability owner (hearsay-tools/squawk#1401)',
  applies: (file) => file.startsWith('packages/web/src/') && /\.tsx?$/.test(file) && file !== 'packages/web/src/lib/capabilities.ts' && !/\.(?:test|testkit)\.tsx?$/.test(file),
  create: (report, context) => ({
    MemberExpression(node) {
      if (!namedMember(node, 'automations', context)) return;
      const object = child(node, 'object');
      if (!object || !sameBoundary(node, object, 0, context)) return;
      if ((object.type === 'Identifier' && context.sourceCode.getText(object) === 'capabilities') || namedMember(object, 'capabilities', context)) report(node, MESSAGE);
    },
  }),
};
