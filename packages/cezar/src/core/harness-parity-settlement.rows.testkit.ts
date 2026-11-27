import { expect } from 'vitest';
import { exemptionFor, HARNESS_ADAPTERS, type HarnessAdapter } from './harness-parity-core.testkit.ts';
import type { StoredEvent } from './harness-parity-permission-route.testkit.ts';
import type { CellBody, HarnessGroup, HarnessRegistrar, ObservedCell } from './harness-parity-registrar.testkit.ts';
import { runnersWhere } from './runner-facts.ts';

/** R23: the worker after its pending question's process completed, and the scratch it left. */
export type PendingScratchObservation = { active: boolean; status: string | undefined; phase: string | undefined; scratch: string };

/** R129: a native ask the idle close dropped, then the run its answer reopened. */
export type IdleClosedAnswer = {
  closedWhileAsking: { active: boolean; status: string | undefined; pendingAsk: boolean };
  status: string | undefined; pendingAsk: boolean; openHumanWaits: unknown[]; idleCloses: number;
  delivered: StoredEvent[]; reopened: number;
};

type ApprovalDecision = NonNullable<HarnessAdapter['approvalDecisions']>[number];

/** The settlement part's cell bodies, which `harness-parity-settlement.cells.testkit.ts` holds, by row id. */
export type SettlementCells = {
  readonly R20: (backend: string) => CellBody;
  readonly R28: (backend: string) => CellBody;
  readonly R29: (backend: string) => CellBody;
  readonly R30: (backend: string) => CellBody;
  readonly R33: (backend: string) => CellBody;
  readonly R34: (backend: string) => CellBody;
  readonly R31: (backend: string) => CellBody;
  readonly R32: (backend: string) => CellBody;
  readonly R22: (backend: string) => CellBody;
  readonly R23: (backend: string) => ObservedCell<PendingScratchObservation>;
  readonly R129: (backend: string, ask: HarnessAdapter['askResumeCases'][number]) => ObservedCell<IdleClosedAnswer>;
  readonly P1: (backend: string, decision: ApprovalDecision['pick'], echo: ApprovalDecision['echo']) => CellBody;
  readonly P2: (backend: string) => CellBody;
  readonly P9: (backend: string, label: string, action: string) => CellBody;
};

/** The settlement part's groups, apart from its bodies so a registration guard loads no run engine. */
export function settlementGroups(cells: SettlementCells) {
  return {
    // #661: native runner completion precedes the real durable cleanup checkpoint.
    // Every adapter supplies baseline; there is no wire exemption for this path.
    cleanup(r: HarnessRegistrar) {
      const { describeRunners, runners, it } = r;
      describeRunners('cleanup', 'harness parity — terminal cleanup reconciliation', () => {
        for (const backend of runners) {
          it(`${backend} R20 cleanup checkpoints read only their family`, cells.R20(backend), 60_000);
        }
      });
    },

    // #473: successful settlement closes intermediate Continues left by idle close.
    'multi-continue'(r: HarnessRegistrar) {
      const { describeRunners, runners, it } = r;
      describeRunners('multi-continue', 'harness parity — multi-Continue settlement', () => {
        for (const backend of runners) {
          for (const status of ['done', 'review', 'cancelled'] as const) {
            const criterion = status === 'done' ? 'R28' : status === 'review' ? 'R29' : 'R30';
            it(`${backend} ${criterion} closes every live step when multi-Continue finishes as ${status}`, cells[criterion](backend), 60_000);
          }
        }
      });
    },

    superseded(r: HarnessRegistrar) {
      const { describeRunners, runners, it } = r;
      describeRunners('superseded', 'harness parity — inactive Finish superseded by Continue', () => {
        for (const backend of runners) {
          for (const queued of [false, true]) {
            const criterion = queued ? 'R34' : 'R33';
            it(`${backend} ${criterion} rejects stale Finish after Continue ${queued ? 'queues' : 'starts and idle-closes'}`, cells[criterion](backend), 60_000);
          }
        }
      });
    },

    disposal(r: HarnessRegistrar) {
      const { describeRunners, runners, it } = r;
      describeRunners('disposal', 'harness parity — accepted Finish across disposal', () => {
        for (const backend of runners) {
          for (const continuation of [false, true]) {
            const criterion = continuation ? 'R32' : 'R31';
            it(`${backend} ${criterion} honors ${continuation ? 'Continue' : 'fresh'} Finish when disposed during diff I/O`, cells[criterion](backend), 60_000);
          }
        }
      });
    },

    // #515: task scratch outlives a process, on both workflow and Continue paths.
    scratch(r: HarnessRegistrar) {
      const { describeRunners, runners, it, parityRow } = r;
      describeRunners('scratch', 'harness parity — live task scratch', () => {
        for (const backend of runners) {
          it(`${backend} R22 retains scratch across idle close and Continue, then reaps on finish`, cells.R22(backend), 60_000);

          const pending = cells.R23(backend);
          parityRow<PendingScratchObservation>(backend, {
            id: 'R23', scenario: 'ask', name: 'R23 retains pending-question worker scratch after its process completes',
            assert: pending.assert,
          }, pending.observe);

          // hearsay-tools/squawk#2701: an idle close drops the open native question; the answer
          // reopens the session as its first message and settles the question.
          if (!runnersWhere(facts => facts.nativeAsk === 'answerable').includes(backend)) continue;
          const ask = HARNESS_ADAPTERS[backend]!.askResumeCases[0]!;
          const answered = cells.R129(backend, ask);
          parityRow<IdleClosedAnswer>(backend, {
            id: 'R129', scenario: 'ask-resume', name: 'R129 idle-closes a parked native ask and reopens the session with its answer',
            assert: answered.assert,
          }, answered.observe);
        }
      });
    },

    permission(r: HarnessRegistrar) {
      const { describeRunners, runners, it } = r;
      describeRunners('permission', 'native permission routing (hearsay-tools/cezarion#1049)', () => {
        for (const backend of runners) {
          const exemption = exemptionFor('P1', backend);
          if (exemption) {
            it(`${backend} P1 exemption — ${exemption.reason}`, () => {
              expect(exemption.kind).toBe('scenario-unconstructible');
              expect(HARNESS_ADAPTERS[backend]!.scenarios.approval).toBeUndefined();
            });
            continue;
          }
          for (const { pick: decision, echo } of HARNESS_ADAPTERS[backend]!.approvalDecisions!) {
            it(`${backend} P1 ${decision} answers the native request through the cockpit API`, cells.P1(backend, decision, echo), 45_000);
          }
        }
      });
    },

    'default-permission'(r: HarnessRegistrar) {
      const { describeRunners, runners, it } = r;
      describeRunners('default-permission', 'default permission asks (hearsay-tools/cezarion#1266)', () => {
        for (const backend of runners) {
          const exemption = exemptionFor('P2', backend);
          if (exemption) {
            it(`${backend} P2 exemption — ${exemption.reason}`, () => {
              expect(exemption.kind).toBe('scenario-unconstructible');
              expect(HARNESS_ADAPTERS[backend]!.scenarios['permission-default']!).toBeUndefined();
            });
            continue;
          }
          it(`${backend} P2 answers its built-in default permission ask without parking`, cells.P2(backend), 45_000);
        }
      });
    },

    // Squawk's own tools are covered where they run: the Codex U1 row of workflows/waits-parity parks only
    // when the mock's MCP tool gate lets cezar_wait through unasked.
    mcp(r: HarnessRegistrar) {
      const { describeRunners, runners, it } = r;
      describeRunners('mcp', 'MCP tool approval routing (hearsay-tools/cezarion#1294)', () => {
        for (const backend of runners) {
          const exemption = exemptionFor('P9', backend);
          if (exemption) {
            it(`${backend} P9 exemption — ${exemption.reason}`, () => {
              expect(exemption.kind).toBe('scenario-unconstructible');
              expect(HARNESS_ADAPTERS[backend]!.scenarios['mcp-approval']!).toBeUndefined();
            });
            continue;
          }
          for (const [label, action] of [['Allow once', 'accept'], ['Decline and continue', 'decline']] as const) {
            it(`${backend} P9 ${action} answers another server's MCP tool approval through the cockpit API`, cells.P9(backend, label, action),
              // bound: per-cell hang guard above driveRun's own 30 s settle bound, sized for a parity cell under host load.
              45_000);
          }
        }
      });
    },
  } satisfies Readonly<Record<string, HarnessGroup>>;
}
