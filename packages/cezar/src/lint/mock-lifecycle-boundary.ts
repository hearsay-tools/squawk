import { child, children, nameOf, stringOf, type AstRule } from './ast-rule.ts';

const NAMES = new Set(['watchdogStall', 'watchdogWritePid', 'waitForMockRelease', 'waitForRelease']);
const PID = /(?:^|[/\\])watchdog\.pid(?:$|[/\\])/;
const MESSAGE = 'Use mock-lifecycle.mjs for the stall, readiness pid and release wait (hearsay-tools/cezarion#1529).';

/** Stall ordering and readiness belong to the lifecycle module, never its callers. */
export const mockLifecycleBoundary: AstRule = {
  name: 'mock-lifecycle-boundary',
  description: 'Native mocks share the no-progress stall and release wait (hearsay-tools/cezarion#1529).',
  applies: file => /^packages\/cezar\/scripts\/mock-[^/]+\.mjs$/.test(file)
    && file !== 'packages/cezar/scripts/mock-lifecycle.mjs',
  create(report) {
    return {
      FunctionDeclaration(node) {
        if (NAMES.has(nameOf(child(node, 'id')) ?? '')) report(node, MESSAGE);
      },
      FunctionExpression(node) {
        if (NAMES.has(nameOf(child(node, 'id')) ?? '')) report(node, MESSAGE);
      },
      VariableDeclarator(node) {
        if (node.parent?.type !== 'VariableDeclaration' || children(node.parent, 'declarations')[0] !== node) return;
        if (NAMES.has(nameOf(child(node, 'id')) ?? '')) report(node, MESSAGE);
      },
      Literal(node) {
        const value = stringOf(node);
        if (value !== undefined && PID.test(value)) report(node, MESSAGE);
      },
      TemplateLiteral(node) {
        if (children(node, 'quasis').some(quasi => {
          const value = quasi.value as { raw: string };
          return PID.test(value.raw);
        })) report(node, MESSAGE);
      },
    };
  },
};
