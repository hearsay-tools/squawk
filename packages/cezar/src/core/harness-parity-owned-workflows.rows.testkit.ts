import type { CellBody, HarnessGroup, HarnessRegistrar } from './harness-parity-registrar.testkit.ts';

/** The owned-workflows part's cell bodies, which `harness-parity-owned-workflows.cells.testkit.ts` holds, by row id. */
export type OwnedWorkflowsCells = {
  readonly R13: (backend: string) => CellBody;
  readonly R42: (backend: string) => CellBody;
  readonly R41: (backend: string) => CellBody;
  readonly R14: (backend: string) => CellBody;
};

/** The owned-workflows part's groups, apart from its bodies so a registration guard loads no run engine. */
export function ownedWorkflowsGroups(cells: OwnedWorkflowsCells) {
  return {
    'owned-workflows'(r: HarnessRegistrar) {
      const { describeRunners, runners, it } = r;
      describeRunners('owned-workflows', 'harness parity — owned workflows', () => {
        for (const backend of runners) {
          it(`${backend} R13 runs a persisted catalog chain inside the owned worker, check step included (#451)`, cells.R13(backend), 60_000);

          it(`${backend} R42 spawns from a skill-driven parent without inheriting its skill on the native wire (#778)`, cells.R42(backend), 60_000);

          it(`${backend} R41 runs a --skill worker with its native trigger and no parent skill (#778)`, cells.R41(backend), 60_000);

          it(`${backend} R14 runs an accepted mixed-runner chain under per-step identity, each step on its own pinned account (#452)`, cells.R14(backend), 60_000);
        }
      });
    },
  } satisfies Readonly<Record<string, HarnessGroup>>;
}
