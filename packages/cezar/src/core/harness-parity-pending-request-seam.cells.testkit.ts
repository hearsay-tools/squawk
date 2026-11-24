/**
 * Seam-only pending-request cells for runners whose `nativePermission` is `'none'`: every P3–P8
 * cell is an exemption pin and the single live cell drives `driveSeam`, so these runner files stay
 * free of the workflow engine (hearsay-tools/squawk#4177).
 */
import { expect } from 'vitest';
import { describeHarnessPart, type HarnessGroup, type HarnessPartScope, type HarnessRegistrar, type HarnessRegistration } from './harness-parity-registrar.testkit.ts';
import { driveSeam, PERMISSION_CRITERIA, waitFor, type ScenarioName } from './harness-parity-core.testkit.ts';
import { RUNNER_FACTS } from './runner-facts.ts';

function expectExempt(r: HarnessRegistrar, id: string, backend: string, scenario: ScenarioName): void {
  if (!r.permissionExemption(id, backend, scenario)) {
    throw new Error(`${backend} is not exempt from ${id}: import harness-parity-pending-request.cells.testkit.ts instead`);
  }
}

const EXEMPT_GROUPS: ReadonlyArray<readonly [string, string, ScenarioName]> = [
  ['retirement-P3', 'P3', 'approval-resolved'],
  ['retirement-P4', 'P4', 'approval-turn-end'],
  ['permission-failure', 'P5', 'approval-reply-fails'],
  ['malformed', 'P6', 'approval-malformed'],
  ['early-permission', 'P7', 'permission-classify'],
];

const SEAM_PENDING_REQUEST_GROUPS: Readonly<Record<string, HarnessGroup>> = {
  ...Object.fromEntries(EXEMPT_GROUPS.map(([group, id, scenario]) => [
    group,
    (r: HarnessRegistrar) => {
      r.describeRunners(group, `${id} ${PERMISSION_CRITERIA.find(c => c.id === id)!.name} (hearsay-tools/cezarion#1266)`, () => {
        for (const backend of r.runners) expectExempt(r, id, backend, scenario);
      });
    },
  ])),
  'late-permission'(r: HarnessRegistrar) {
    r.describeRunners('late-permission', `P8 ${PERMISSION_CRITERIA.find(c => c.id === 'P8')!.name} (hearsay-tools/cezarion#1266)`, () => {
      for (const backend of r.runners) {
        const closesWhenQuiet = RUNNER_FACTS[backend]!.nativePermission === 'after-turn';
        if (closesWhenQuiet) {
          throw new Error(`${backend} declares nativePermission after-turn: import harness-parity-pending-request.cells.testkit.ts instead`);
        }
        r.it(`${backend} closes on an accepted done at once, as its nativePermission declares`, async () => {
          const observation = await driveSeam(backend, 'baseline', {
            whileOpen: async (session, observed) => {
              await waitFor(() => observed.v1.some(event => event.type === 'turn-end'));
              expect(typeof session.endWhenQuiet).toBe('undefined');
            },
          });
          expect(observation.failure).toBeUndefined();
        // bound: per-cell hang guard for one mock session, sized for a parity cell under host load.
        }, 45_000);
        expectExempt(r, 'P8', backend, 'permission-late');
      }
    });
  },
};

/** Register the pending-request part's seam-only cells for a runner with `nativePermission: 'none'`. */
export function describeHarnessParity(scope: HarnessPartScope, registration?: HarnessRegistration): void {
  describeHarnessPart('pending-request', SEAM_PENDING_REQUEST_GROUPS, scope, registration);
}
