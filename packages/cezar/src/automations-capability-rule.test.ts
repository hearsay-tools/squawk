import { describe, expect, it } from 'vitest';
import { automationsCapabilityReadOutsideOwner as rule } from './lint/automations-capability-read-outside-owner.ts';

/** One AST rule covers both cockpit grammars (hearsay-tools/squawk#1401). */
describe('the automations-capability-read-outside-owner rule', () => {
  it.each([
    ['packages/web/src/nav.ts', true],
    ['packages/web/src/nested/nav.tsx', true],
    ['packages/web/src/lib/capabilities.ts', false],
    ['packages/web/src/lib/capabilities.tsx', true],
    ['packages/web/src/nav.test.ts', false],
    ['packages/web/src/nav.test.tsx', false],
    ['packages/web/src/nav.testkit.ts', false],
    ['packages/web/src/nav.testkit.tsx', false],
    ['packages/cezar/src/nav.ts', false],
    ['packages/web/e2e/nav.tsx', false],
  ])('reads %s: %s', (file, applies) => expect(rule.applies(file)).toBe(applies));
});
