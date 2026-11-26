import { PERMISSION_CRITERIA, type ScenarioName } from './harness-parity-core.testkit.ts';
import type { CellBody, HarnessGroup, HarnessRegistrar } from './harness-parity-registrar.testkit.ts';
import { RUNNER_FACTS } from './runner-facts.ts';

/** P3 and P4: the cards a backend retires, with the scenario that retires each. */
const RETIREMENTS = [
  { id: 'P3', scenario: 'approval-resolved' },
  { id: 'P4', scenario: 'approval-turn-end' },
] as const;

/** Where a late card follows the done in P8's workflow cells. */
export const LATE_DONE_STEPS = ['a non-final step', 'the final step'] as const;
export type LateDoneStep = typeof LATE_DONE_STEPS[number];

/** The pending-request part's cell bodies, which `harness-parity-pending-request.cells.testkit.ts` holds, by row id. */
export type PendingRequestCells = {
  readonly P3: (backend: string, scenario: ScenarioName) => CellBody;
  readonly P4: (backend: string, scenario: ScenarioName) => CellBody;
  readonly P5: (backend: string) => CellBody;
  readonly P6: (backend: string) => CellBody;
  readonly P7: (backend: string) => CellBody;
  readonly closeOnDone: (backend: string, closesWhenQuiet: boolean) => CellBody;
  readonly P8: (backend: string) => CellBody;
  readonly P8Step: (backend: string, where: LateDoneStep) => CellBody;
  readonly P8Continue: (backend: string) => CellBody;
  readonly P8Finish: (backend: string) => CellBody;
};

/** The pending-request part's groups, apart from its bodies so a registration guard loads no run engine. */
export function pendingRequestGroups(cells: PendingRequestCells) {
  return {
    retirements(r: HarnessRegistrar) {
      const { describeRunners, runners, it, permissionExemption } = r;
      for (const { id, scenario } of RETIREMENTS) {
        describeRunners(`retirement-${id}`, `${id} ${PERMISSION_CRITERIA.find(c => c.id === id)!.name} (hearsay-tools/cezarion#1266)`, () => {
          for (const backend of runners) {
            if (permissionExemption(id, backend, scenario)) continue;
            // bound: per-cell hang guard above driveRun's own 30 s settle bound, sized for a parity cell under host load.
            it(`${backend} ${id} retires the card, its capability and the run's pending permission`, cells[id](backend, scenario), 45_000);
          }
        });
      }
    },

    'permission-failure'(r: HarnessRegistrar) {
      const { describeRunners, runners, it, permissionExemption } = r;
      describeRunners('permission-failure', `P5 ${PERMISSION_CRITERIA.find(c => c.id === 'P5')!.name} (hearsay-tools/cezarion#1266)`, () => {
        for (const backend of runners) {
          if (permissionExemption('P5', backend, 'approval-reply-fails')) continue;
          // bound: per-cell hang guard above driveRun's own 30 s settle bound, sized for a parity cell under host load.
          it(`${backend} P5 replaces the card it could not deliver and keeps the run waiting`, cells.P5(backend), 45_000);
        }
      });
    },

    malformed(r: HarnessRegistrar) {
      const { describeRunners, runners, it, permissionExemption } = r;
      describeRunners('malformed', `P6 ${PERMISSION_CRITERIA.find(c => c.id === 'P6')!.name} (hearsay-tools/cezarion#1266)`, () => {
        for (const backend of runners) {
          if (permissionExemption('P6', backend, 'approval-malformed')) continue;
          // bound: per-cell hang guard above driveRun's own 30 s settle bound, sized for a parity cell under host load.
          it(`${backend} P6 refuses the malformed request natively and the turn goes on`, cells.P6(backend), 45_000);
        }
      });
    },

    'early-permission'(r: HarnessRegistrar) {
      const { describeRunners, runners, it, permissionExemption } = r;
      describeRunners('early-permission', `P7 ${PERMISSION_CRITERIA.find(c => c.id === 'P7')!.name} (hearsay-tools/cezarion#1266)`, () => {
        for (const backend of runners) {
          if (permissionExemption('P7', backend, 'permission-classify')) continue;
          // Agent input reaches a session only through `sendAgentMessage`, so the cell drives the seam.
          // bound: per-cell hang guard above driveRun's own 30 s settle bound, sized for a parity cell under host load.
          it(`${backend} P7 refuses agent input before the card and drops the request settled meanwhile`, cells.P7(backend), 45_000);
        }
      });
    },

    'late-permission'(r: HarnessRegistrar) {
      const { describeRunners, runners, it, permissionExemption } = r;
      describeRunners('late-permission', `P8 ${PERMISSION_CRITERIA.find(c => c.id === 'P8')!.name} (hearsay-tools/cezarion#1266)`, () => {
        for (const backend of runners) {
          // The close after an accepted done follows the declared nativePermission (hearsay-tools/squawk#1680):
          // only a wire that can raise a request after its turn keeps the session up for one.
          const closesWhenQuiet = RUNNER_FACTS[backend]!.nativePermission === 'after-turn';
          // bound: per-cell hang guard for one mock session, sized for a parity cell under host load.
          it(`${backend} closes on an accepted done ${closesWhenQuiet ? 'once no late permission request is pending' : 'at once'}, as its nativePermission declares`, cells.closeOnDone(backend, closesWhenQuiet), 45_000);
          if (permissionExemption('P8', backend, 'permission-late')) continue;
          // A session's own close (autoEndAfterFirstTurn) lives at the seam.
          // bound: per-cell hang guard above driveRun's own 30 s settle bound, sized for a parity cell under host load.
          it(`${backend} P8 reopens the turn for the late card and ends the session after that turn`, cells.P8(backend), 45_000);

          // Through RunManager an accepted done keeps this session open briefly (hearsay-tools/squawk#1680):
          // the late card pends, its answer reaches the runner, and the step settles as the done said.
          for (const where of LATE_DONE_STEPS) {
            // bound: per-cell hang guard above driveRun's own 30 s settle bound, sized for a parity cell under host load.
            it(`${backend} P8 shows a late card after the done of ${where} and settles it done once the card is answered`, cells.P8Step(backend, where), 45_000);
          }

          // bound: per-cell hang guard above driveRun's own 30 s settle bound, sized for a parity cell under host load.
          it(`${backend} P8 shows a late card after a Continue's done and settles it done once the card is answered`, cells.P8Continue(backend), 60_000);

          // A human Finish still reaches the session that closes on its done, as it reaches an open one.
          // bound: per-cell hang guard above driveRun's own 30 s settle bound, sized for a parity cell under host load.
          it(`${backend} P8 Finish while a late card pends closes the session and settles the run done`, cells.P8Finish(backend), 45_000);
        }
      });
    },
  } satisfies Readonly<Record<string, HarnessGroup>>;
}
