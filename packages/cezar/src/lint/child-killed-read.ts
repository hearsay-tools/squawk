import { child, children, nameOf, type AstRule, type EsNode } from './ast-rule.ts';

/**
 * `ChildProcess.killed` says a signal was delivered, not that the child ended
 * (open-mercato/cezar#844). Production `.ts` files in `packages/cezar/src` read neither a
 * `.killed` member nor a `killed` key in a destructuring pattern. The rule knows no type, so it
 * matches the name on any receiver. It leaves out a receiver whose name ends in `err`, `error` or
 * `failure`, because the error of an exec call carries its own `killed`, and a computed key.
 */

const MESSAGE =
  'ChildProcess.killed says a signal was delivered, not that the child ended, so a watchdog that ' +
  'gates its SIGKILL on it never escalates (open-mercato/cezar#844). Ask real termination: ' +
  'trackChildExit(child) in packages/cezar/src/core/agent-runner.ts.';

const ERROR_NAME = /(err|error|failure)$/i;

/** `error.killed`, `commandError?.killed` and `failure.err.killed` read an exec error's own field. */
function isErrorReceiver(receiver: EsNode | undefined): boolean {
  if (!receiver) return false;
  const name = receiver.type === 'MemberExpression' ? nameOf(child(receiver, 'property')) : nameOf(receiver);
  return name !== undefined && ERROR_NAME.test(name);
}

/** A public `killed` name; `this.#killed` is a class's own private field, not the child's. */
function isKilledKey(owner: EsNode, field: string): boolean {
  const key = child(owner, field);
  return owner.computed !== true && key?.type === 'Identifier' && nameOf(key) === 'killed';
}

export const childKilledRead: AstRule = {
  name: 'child-killed-read',
  description: 'ChildProcess.killed reads; use trackChildExit (open-mercato/cezar#844)',
  applies: (file) =>
    file.startsWith('packages/cezar/src/') && file.endsWith('.ts') && !file.endsWith('.test.ts') && !file.endsWith('.testkit.ts'),
  create: (report) => ({
    MemberExpression(node) {
      if (isKilledKey(node, 'property') && !isErrorReceiver(child(node, 'object'))) report(node, MESSAGE);
    },
    ObjectPattern(node) {
      for (const property of children(node, 'properties')) {
        if (property.type === 'Property' && isKilledKey(property, 'key')) report(property, MESSAGE);
      }
    },
  }),
};
