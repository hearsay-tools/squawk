import { checkRule } from './ast-rule.testkit.ts';
import { waitVisitors, type WaitProfile } from './wait-ast-visitors.ts';
import type { Site } from './unit-wait-discipline.ts';

/** Runs wait fixtures through the same oxlint visitors as the plugin (hearsay-tools/squawk#3774). */
export function scanWaitAst(profile: WaitProfile, file: string, source: string): Site[] {
  let sites: Site[] = [];
  checkRule({
    name: `wait-${profile}-fixture`,
    description: 'Wait-rule AST fixture collection (hearsay-tools/squawk#3774).',
    applies: () => true,
    create(_report, context) {
      return waitVisitors(profile, { ...context, file }, found => { sites = found.map(({ node: _node, ...site }) => site); });
    },
  }, file, source);
  return sites;
}
