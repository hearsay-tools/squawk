import { child, children, nameOf, stringOf, type AstRule, type EsNode } from './ast-rule.ts';
import { propertyName, unwrap, walk } from './ast-syntax.ts';

/** Tests use the real native mocks and change behavior through their controls
 * (hearsay-tools/cezarion#1479). Standalone fakes remain allowed. */
const SCANNED = ['packages/cezar/src/', 'packages/cezar/test/'];
const SELF = 'packages/cezar/src/lint/native-mock-source.ts';
type MockRule = 'reads native mock source' | 'assigns an adapter mockBin' | 'imports the mock source patcher';

function mockArgument(node: EsNode): boolean {
  let found = false;
  walk(node, part => {
    const name = nameOf(part);
    if (name === 'mockBin' || (name !== undefined && /^[A-Z][A-Z_]*_MOCK$/.test(name))) found = true;
    const value = stringOf(part);
    if (value !== undefined && /mock-[\w-]+\.mjs/.test(value)) found = true;
  });
  return found;
}

export const nativeMockSource: AstRule = {
  name: 'native-mock-source',
  description: 'Tests run the real native mocks; they never read, splice or swap mock source (hearsay-tools/cezarion#1479).',
  applies: file => SCANNED.some(dir => file.startsWith(dir)) && file.endsWith('.ts') && !file.includes('/node_modules/') && file !== SELF,
  create(report) {
    const found = (node: EsNode, rule: MockRule) => report(node, `Test ${rule}. Change a mock through its own control (CEZ_MOCK_FAILURE_CONTROL, CEZ_MOCK_DELIVERY_CONTROL) or a native scenario token, or write a standalone fake (hearsay-tools/cezarion#1479).`);
    return {
      CallExpression(node) {
        const callee = unwrap(child(node, 'callee'));
        if (callee?.type === 'MemberExpression' && callee.computed) return;
        if (!['readFile', 'readFileSync'].includes(propertyName(callee) ?? '')) return;
        if (children(node, 'arguments').some(mockArgument)) found(callee!, 'reads native mock source');
      },
      AssignmentExpression(node) {
        const left = unwrap(child(node, 'left'));
        if (node.operator === '=' && left?.type === 'MemberExpression' && !left.computed && propertyName(left) === 'mockBin') found(left, 'assigns an adapter mockBin');
      },
      Literal(node) {
        const value = stringOf(node);
        if (value !== undefined && /mock-patch\.testkit(?:\.ts)?$/.test(value)) found(node, 'imports the mock source patcher');
      },
    };
  },
};
