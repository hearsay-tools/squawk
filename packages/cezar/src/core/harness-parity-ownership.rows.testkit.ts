import type { RunRecord } from '../runs/store.ts';
import type { HarnessGroup, HarnessRegistrar, ObservedCell } from './harness-parity-registrar.testkit.ts';
import type { RunObservation } from './workflow-parity-core.testkit.ts';

/** What R48 reads: the pins Continue takes, and whether the run leaves memory before and after it. */
export type ContinueObservation = { pins: string[]; left: boolean; heldWhileContinuing: boolean; leftAgain: boolean; obs: RunObservation };

/** What R49 reads: the repaired Finish intent, the run leaving memory, and the Continue after it. */
export type RestartObservation = { repaired: boolean; left: boolean; continued: { ok: boolean; error?: string }; final: RunRecord | undefined };

/** What R51 reads: the adoption, the agents it and Continue start, and the run after each. */
export type AdoptObservation = { adopted: boolean; startedByAdoption: string[]; settled: RunRecord | undefined; continued: { ok: boolean; error?: string }; startedByContinue: string[]; resumed: RunRecord | undefined };

/** What R52 reads: the adoption, the agents it starts, and the stopped run. */
export type StopObservation = { adopted: boolean; started: string[]; stopped: RunRecord | undefined };

/** The ownership part's cell bodies, which `harness-parity-ownership.cells.testkit.ts` holds, by row id. */
export type OwnershipCells = {
  readonly R48: (backend: string) => ObservedCell<ContinueObservation>;
  readonly R49: (backend: string) => ObservedCell<RestartObservation>;
  readonly R51: (backend: string) => ObservedCell<AdoptObservation>;
  readonly R52: (backend: string) => ObservedCell<StopObservation>;
};

/** The ownership part's groups, apart from its bodies so a registration guard loads no run engine. */
export function ownershipGroups(cells: OwnershipCells) {
  return {
    // #779: only the live set is in memory. A finished run is read back from runs.db; Continue loads
    // it into the held set (the `continue` pin), `runContinuation` pins it through the same `activate`
    // helper `execute` uses, and it leaves memory again once the continuation settles.
    continue(r: HarnessRegistrar) {
      const { describeRunners, runners, parityRow } = r;
      describeRunners('continue', 'harness parity — Continue on a finished run (#779)', () => {
        for (const backend of runners) {
          const cell = cells.R48(backend);
          parityRow<ContinueObservation>(backend, {
            id: 'R48', name: 'R48 Continue loads a finished run into memory and lets it go after it settles', scenario: 'cezar-done',
            assert: cell.assert,
          }, cell.observe);
        }
      });
    },

    // #779: older controllers could cancel a root and leave its Finish intent on the record. Restart
    // repairs that in the delegation sweep, which since #779 reaches only what `open` loads; a finished
    // root the sweep missed would be refused by every Continue ("parent finish is pending") for good.
    restart(r: HarnessRegistrar) {
      const { describeRunners, runners, parityRow } = r;
      describeRunners('restart', 'harness parity — restart repairs a stale root Finish intent (#779)', () => {
        for (const backend of runners) {
          const cell = cells.R49(backend);
          parityRow<RestartObservation>(backend, {
            id: 'R49', name: "R49 restart clears a cancelled root's stale Finish intent and Continue resumes it", scenario: 'cezar-done',
            assert: cell.assert,
          }, cell.observe);
        }
      });
    },

    // #779 plan step 3: a control (archive, Stop, Continue…) on a run whose owning process died adopts
    // it first. Adopting settles it — nothing is resumed behind the user's back, whichever runner it
    // used — and Continue is the one control that starts its agent again, on its own session.
    adopt(r: HarnessRegistrar) {
      const { describeRunners, runners, parityRow } = r;
      describeRunners('adopt', 'harness parity — adopting a dead owner\'s run mid-turn (#779)', () => {
        for (const backend of runners) {
          const cell = cells.R51(backend);
          parityRow<AdoptObservation>(backend, {
            id: 'R51', name: 'R51 adopting a dead owner\'s run mid-turn starts no agent, and Continue resumes it', scenario: 'hold',
            assert: cell.assert,
          }, cell.observe);
        }
      });
    },

    // #779: Stop is the control an adoption carries out itself. The run it stops ends cancelled, as an
    // accepted Stop always reads, rather than interrupted, whichever runner it used; nothing starts.
    stop(r: HarnessRegistrar) {
      const { describeRunners, runners, parityRow } = r;
      describeRunners('stop', 'harness parity — Stop on a dead owner\'s run mid-turn (#779)', () => {
        for (const backend of runners) {
          const cell = cells.R52(backend);
          parityRow<StopObservation>(backend, {
            id: 'R52', name: 'R52 Stop on a dead owner\'s run mid-turn ends it cancelled and starts no agent', scenario: 'hold',
            assert: cell.assert,
          }, cell.observe);
        }
      });
    },
  } satisfies Readonly<Record<string, HarnessGroup>>;
}
