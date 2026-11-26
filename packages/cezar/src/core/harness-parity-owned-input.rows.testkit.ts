import type { CellBody, HarnessGroup, HarnessRegistrar } from './harness-parity-registrar.testkit.ts';

/** The owned-input part's cell bodies, which `harness-parity-owned-input.cells.testkit.ts` holds, by row id. */
export type OwnedInputCells = {
  readonly R6: (backend: string) => CellBody;
  readonly R131: (backend: string) => CellBody;
  readonly R7: (backend: string) => CellBody;
  readonly refusedAnswer: (backend: string) => CellBody;
  readonly R10: (backend: string) => CellBody;
  readonly R11: (backend: string) => CellBody;
  readonly R9: (backend: string) => CellBody;
  readonly R8: (backend: string) => CellBody;
};

/** The owned-input part's groups, apart from its bodies so a registration guard loads no run engine. */
export function ownedInputGroups(cells: OwnedInputCells) {
  return {
    owned(r: HarnessRegistrar) {
      const { describeRunners, runners, it } = r;
      describeRunners('owned', 'harness parity — owned input run tier', () => {
        for (const backend of runners) {
          it(`${backend} R6 queues before/during asks and drains only after the parent's answer`, cells.R6(backend), 60_000);

          // hearsay-tools/squawk#2444: the open human wait holds input from the moment cezar_ask
          // registers it, so no session callback at the turn end delivers the input before the
          // card is answered.
          it(`${backend} R131 input queued after cezar_ask in the same turn reaches the agent only after the answer`, cells.R131(backend), 60_000);

          it(`${backend} R7 restart retains pending asks and input; only the parent's answer drains it`, cells.R7(backend), 60_000);

          it(`${backend} refused answer delivery retains the ask live and after restart`, cells.refusedAnswer(backend), 60_000);

          it(`${backend} R10 accepted input precedes DONE but explicit termination is never prolonged`, cells.R10(backend), 60_000);

          it(`${backend} R11 post-send checkpoint failure interrupts and reports failure without dropping input`, cells.R11(backend), 60_000);

          it(`${backend} R9 continuation asks keep input queued through delayed native reply acknowledgement`, cells.R9(backend), 60_000);

          it(`${backend} R8 queued restart/starting inputs persist; disk failure emits and delivers nothing`, cells.R8(backend), 60_000);
        }
      });
    },
  } satisfies Readonly<Record<string, HarnessGroup>>;
}
