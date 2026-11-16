/**
 * The pending native request's lifecycle (hearsay-tools/cezarion#1266, P3–P8): a card the backend
 * retires, an answer it refuses, a malformed request, and requests that arrive before or after the
 * turn. Split from the settlement part so each runner file stays well under the per-file duration cap.
 */
import type { RunnerId } from './agent-runner.ts';
import type { HarnessParityPart } from './harness-parity-parts.testkit.ts';
import { describeHarnessPart, type HarnessGroup, type HarnessRegistrar, type HarnessRegistration } from './harness-parity-registrar.testkit.ts';
import { RUN_STATUS, STEP_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'vitest';
import { testHome } from '../home/test-home.testkit.ts';
import { readMockRecords } from '../mock-records.testkit.ts';
import type { RunRecord } from '../runs/store.ts';
import { apiRequest } from '../server/loopback-request.testkit.ts';
import { createApp } from '../server/server.ts';
import type { WorkflowDef } from '../workflows/types.ts';
import { driveSeam, HARNESS_ADAPTERS, PERMISSION_CRITERIA, promptFor, textEvents, waitFor } from './harness-parity-core.testkit.ts';
import { RUNNER_FACTS } from './runner-facts.ts';
import type { UiEvent } from './ui-events.ts';
import { driveRun, type RunObservation } from './workflow-parity-core.testkit.ts';

import { answerThroughRoute, type StoredEvent } from './harness-parity-permission-route.testkit.ts';

type PermissionRequestedEvent = Extract<UiEvent, { type: 'permission.requested' }>;
const joinedText = (events: readonly StoredEvent[]) => events.filter(event => event.type === 'text').map(event => event.text).join('');
const permissionResolutionsOf = (events: readonly StoredEvent[]) => events.filter(event => event.type === 'permission.resolved');

/** A fresh `CEZ_MOCK_RELEASE_FILE` path; the mock waits for the file before its next step. */
async function withRelease<T>(body: (release: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'cez-permission-'));
  try { return await body(join(dir, 'release')); } finally { rmSync(dir, { recursive: true, force: true }); }
}


const optionPicked = (request: StoredEvent, pick: string) =>
  (request.options as Array<{ id: string; label: string }>).find(option => option.label.toLowerCase().includes(pick))!;

const RETIREMENTS = [
  { id: 'P3', scenario: 'approval-resolved', text: 'Native approval settled without a cockpit answer.' },
  { id: 'P4', scenario: 'approval-turn-end', text: 'Turn ended with the approval still pending.' },
] as const;

export const PENDING_REQUEST_GROUPS = {
  retirements(r: HarnessRegistrar) {
    const { describeRunners, runners, it, permissionExemption } = r;
    for (const { id, scenario, text } of RETIREMENTS) {
      describeRunners(`retirement-${id}`, `${id} ${PERMISSION_CRITERIA.find(c => c.id === id)!.name} (hearsay-tools/cezarion#1266)`, () => {
        for (const backend of runners) {
          if (permissionExemption(id, backend, scenario)) continue;
          it(`${backend} ${id} retires the card, its capability and the run's pending permission`, async () => {
            await withRelease(async (release) => {
              let requestId = '';
              // P4's agent calls cezar_done while the request is still pending, and a pending request
              // refuses it (human_question_pending), so its run parks once the turn end retires the card.
              const settled = (run: RunObservation['record']) => !!run && (['done', 'review'].includes(run.status) ||
                (id === 'P4' && run.status === RUN_STATUS.waiting && run.hasPendingPermission === false));
              // bound: hang guard for the live mock run; the predicate waits on the run settling, and a stuck card fails here instead of at the test timeout.
              const observation = await driveRun(backend, scenario, settled, 30_000, undefined, {
                env: { CEZ_MOCK_RELEASE_FILE: release },
                during: async ({ store, manager, runId }) => {
                  await waitFor(() => store.readEvents(runId).some(event => event.type === 'permission.requested'));
                  const request = store.readEvents(runId).find(event => event.type === 'permission.requested')!;
                  requestId = request.requestId as string;
                  expect(store.getRun(runId)).toMatchObject({ status: RUN_STATUS.waiting, hasPendingPermission: true });
                  expect(manager.sendMessage(runId, [{ type: 'text', text: 'accept' }])).toBe(false);
                  writeFileSync(release, 'go');
                  await waitFor(() => store.readEvents(runId).some(event => event.type === 'permission.resolved' && event.requestId === requestId));
                  // The retired card answers nothing, whether or not the run has moved on yet.
                  expect(manager.respondPermission(runId, requestId, (request.options as Array<{ id: string }>)[0]!.id)).toBe(false);
                },
              });
              const resolutions = permissionResolutionsOf(observation.events);
              expect(resolutions).toEqual([expect.objectContaining({ requestId, reason: expect.any(String) })]);
              expect(resolutions[0]).not.toHaveProperty('optionId');
              expect(observation.record?.hasPendingPermission).toBe(false);
              expect(joinedText(observation.events)).toContain(text);
              expect(observation.events).toContainEqual(expect.objectContaining({ type: 'turn.completed' }));
            });
          // bound: per-cell hang guard above driveRun's own 30 s settle bound, sized for a parity cell under host load.
          }, 45_000);
        }
      });
    }
  },

  'permission-failure'(r: HarnessRegistrar) {
    const { describeRunners, runners, it, permissionExemption } = r;
    describeRunners('permission-failure', `P5 ${PERMISSION_CRITERIA.find(c => c.id === 'P5')!.name} (hearsay-tools/cezarion#1266)`, () => {
      for (const backend of runners) {
        if (permissionExemption('P5', backend, 'approval-reply-fails')) continue;
        it(`${backend} P5 replaces the card it could not deliver and keeps the run waiting`, async () => {
          let repoRoot = '';
          const { pick, echo } = HARNESS_ADAPTERS[backend].approvalDecisions![0]!;
          let freshId = '';
          // bound: hang guard for the live mock run; the predicate waits on the run settling, and a stuck card fails here instead of at the test timeout.
          const observation = await driveRun(backend, 'approval-reply-fails', run => !!run && ['done', 'review'].includes(run.status), 30_000, undefined, {
            beforeStart: context => { repoRoot = context.repoRoot; },
            during: async ({ store, manager, runId }) => {
              const requests = () => store.readEvents(runId).filter(event => event.type === 'permission.requested');
              await waitFor(() => requests().length === 1);
              const first = requests()[0]!;
              const firstChoice = optionPicked(first, pick);
              // From the refused answer to the replacement card, the run never stops waiting on a card.
              const changes: Array<{ status: string; hasPendingPermission?: boolean | undefined }> = [];
              const recordChange = (record: RunRecord) => {
                if (record.id === runId) changes.push({ status: record.status, hasPendingPermission: record.hasPendingPermission });
              };
              store.on('run', recordChange);
              try {
                const response = await answerThroughRoute(repoRoot, store, manager, runId, first, firstChoice.id);
                expect(response.status).toBe(200);
                expect(await response.json()).toEqual({ delivered: true });
                await waitFor(() => requests().length === 2 &&
                  store.readEvents(runId).some(event => event.type === 'permission.resolved' && event.requestId === first.requestId));
              } finally { store.off('run', recordChange); }
              for (const change of changes) expect(change).toEqual({ status: RUN_STATUS.waiting, hasPendingPermission: true });
              const events = store.readEvents(runId);
              const fresh = requests()[1]!;
              freshId = fresh.requestId as string;
              expect(freshId).not.toBe(first.requestId);
              const oldResolution = events.findIndex(event => event.type === 'permission.resolved' && event.requestId === first.requestId);
              expect(events.findIndex(event => event.type === 'permission.requested' && event.requestId === freshId)).toBeLessThan(oldResolution);
              expect(events[oldResolution]).toMatchObject({ reason: expect.any(String) });
              expect(events[oldResolution]).not.toHaveProperty('optionId');
              expect(store.getRun(runId)).toMatchObject({ status: RUN_STATUS.waiting, hasPendingPermission: true });
              expect(manager.respondPermission(runId, first.requestId as string, firstChoice.id)).toBe(false);
              expect(manager.sendMessage(runId, [{ type: 'text', text: 'accept' }])).toBe(false);
              const retry = await answerThroughRoute(repoRoot, store, manager, runId, fresh, optionPicked(fresh, pick).id);
              expect(retry.status).toBe(200);
            },
          });
          expect(permissionResolutionsOf(observation.events).filter(event => event.optionId !== undefined))
            .toEqual([expect.objectContaining({ requestId: freshId, optionId: expect.any(String) })]);
          expect(observation.record?.hasPendingPermission).toBe(false);
          expect(joinedText(observation.events)).toContain(echo);
          expect(observation.events).toContainEqual(expect.objectContaining({ type: 'turn.completed' }));
        // bound: per-cell hang guard above driveRun's own 30 s settle bound, sized for a parity cell under host load.
        }, 45_000);
      }
    });
  },

  malformed(r: HarnessRegistrar) {
    const { describeRunners, runners, it, permissionExemption } = r;
    describeRunners('malformed', `P6 ${PERMISSION_CRITERIA.find(c => c.id === 'P6')!.name} (hearsay-tools/cezarion#1266)`, () => {
      for (const backend of runners) {
        if (permissionExemption('P6', backend, 'approval-malformed')) continue;
        it(`${backend} P6 refuses the malformed request natively and the turn goes on`, async () => {
          // bound: hang guard for the live mock run; the predicate waits on the run settling, and a stuck card fails here instead of at the test timeout.
          const observation = await driveRun(backend, 'approval-malformed', run => !!run && ['done', 'review'].includes(run.status), 30_000);
          expect(observation.events.some(event => event.type === 'permission.requested')).toBe(false);
          expect(observation.record?.hasPendingPermission).toBeFalsy();
          expect(observation.statuses).not.toContain('waiting');
          expect(joinedText(observation.events)).toContain(HARNESS_ADAPTERS[backend].malformedApprovalEcho!);
          expect(observation.events).toContainEqual(expect.objectContaining({ type: 'turn.completed' }));
        // bound: per-cell hang guard above driveRun's own 30 s settle bound, sized for a parity cell under host load.
        }, 45_000);
      }
    });
  },

  'early-permission'(r: HarnessRegistrar) {
    const { describeRunners, runners, it, permissionExemption } = r;
    describeRunners('early-permission', `P7 ${PERMISSION_CRITERIA.find(c => c.id === 'P7')!.name} (hearsay-tools/cezarion#1266)`, () => {
      for (const backend of runners) {
        if (permissionExemption('P7', backend, 'permission-classify')) continue;
        // Agent input reaches a session only through `sendAgentMessage`, so the cell drives the seam.
        it(`${backend} P7 refuses agent input before the card and drops the request settled meanwhile`, async () => {
          await withRelease(async (release) => {
            const argsFile = `${release}.args.ndjson`;
            let inputReady = 0;
            const observation = await driveSeam(backend, 'permission-classify', {
              spec: { env: { CEZ_HANDOFF_FILE: '', CEZ_MOCK_ARGS_FILE: argsFile, CEZ_MOCK_RELEASE_FILE: release } },
              sessionOptions: { onAgentInputReady: () => { inputReady += 1; } },
              whileOpen: async (session, observed) => {
                await waitFor(() => existsSync(`${release}.config-read`));
                expect(session.sendAgentMessage([{ type: 'text', text: 'steer' }])).toBe(false);
                const before = inputReady;
                writeFileSync(`${release}.settle`, 'go');
                // SSE frames are handled in order: the text after the native reply proves it was read.
                await waitFor(() => observed.v2.some(event => JSON.stringify(event).includes('OpenCode settled the ask itself.')));
                await waitFor(() => inputReady > before);
                writeFileSync(release, 'go');
                await waitFor(() => observed.v2.some(event => event.type === 'permission.requested'));
                const requests = observed.v2.filter((event): event is PermissionRequestedEvent => event.type === 'permission.requested');
                expect(requests).toHaveLength(1);
                expect(JSON.parse(requests[0]!.details!)).toMatchObject({ patterns: ['marker'] });
                const allow = requests[0]!.options.find(option => option.label.toLowerCase().includes('allow once'))!;
                expect(session.respondPermission!(requests[0]!.requestId, allow.id)).toBe(true);
                await waitFor(() => observed.v1.some(event => event.type === 'turn-end'));
              },
            });
            expect(observation.failure).toBeUndefined();
            const urls = readMockRecords<{ url?: string }>(argsFile).map(row => row.url);
            expect(urls).not.toContain('/permission/per_mock_classify/reply');
            expect(urls).toContain('/permission/per_mock_marker/reply');
          });
        // bound: per-cell hang guard above driveRun's own 30 s settle bound, sized for a parity cell under host load.
        }, 45_000);
      }
    });
  },

  'late-permission'(r: HarnessRegistrar) {
    const { describeRunners, runners, it, permissionExemption } = r;
    describeRunners('late-permission', `P8 ${PERMISSION_CRITERIA.find(c => c.id === 'P8')!.name} (hearsay-tools/cezarion#1266)`, () => {
      for (const backend of runners) {
        // The close after an accepted done follows the declared nativePermission (hearsay-tools/squawk#1680):
        // only a wire that can raise a request after its turn keeps the session up for one.
        const closesWhenQuiet = RUNNER_FACTS[backend].nativePermission === 'after-turn';
        it(`${backend} closes on an accepted done ${closesWhenQuiet ? 'once no late permission request is pending' : 'at once'}, as its nativePermission declares`, async () => {
          const observation = await driveSeam(backend, 'baseline', {
            whileOpen: async (session, observed) => {
              await waitFor(() => observed.v1.some(event => event.type === 'turn-end'));
              expect(typeof session.endWhenQuiet).toBe(closesWhenQuiet ? 'function' : 'undefined');
              if (!session.endWhenQuiet) return;
              session.endWhenQuiet();
              expect(session.open).toBe(false);
              await waitFor(() => observed.v1.some(event => event.type === 'done'));
            },
          });
          expect(observation.failure).toBeUndefined();
        // bound: per-cell hang guard for one mock session, sized for a parity cell under host load.
        }, 45_000);
        if (permissionExemption('P8', backend, 'permission-late')) continue;
        // A session's own close (autoEndAfterFirstTurn) lives at the seam.
        it(`${backend} P8 reopens the turn for the late card and ends the session after that turn`, async () => {
          const observation = await driveSeam(backend, 'permission-late', {
            sessionOptions: { autoEndAfterFirstTurn: true },
            whileOpen: async (session, observed) => {
              const turnEnds = () => observed.v1.filter(event => event.type === 'turn-end').length;
              await waitFor(() => observed.v2.some(event => event.type === 'permission.requested'));
              expect(turnEnds()).toBe(1);
              const started = observed.v2.flatMap((event, index) => event.type === 'turn.started' ? [index] : []);
              expect(started).toHaveLength(2);
              expect(observed.v2.findIndex(event => event.type === 'turn.completed')).toBeLessThan(started[1]!);
              expect(started[1]!).toBeLessThan(observed.v2.findIndex(event => event.type === 'permission.requested'));
              expect(session.open).toBe(true);
              const request = observed.v2.find((event): event is PermissionRequestedEvent => event.type === 'permission.requested')!;
              const allow = request.options.find(option => option.label.toLowerCase().includes('allow once'))!;
              expect(session.respondPermission!(request.requestId, allow.id)).toBe(true);
              await waitFor(() => !session.open);
              expect(turnEnds()).toBe(2);
            },
          });
          expect(observation.failure).toBeUndefined();
          expect(observation.v2.filter(event => event.type === 'permission.resolved'))
            .toEqual([expect.objectContaining({ optionId: expect.any(String) })]);
          expect(observation.v2.filter(event => event.type === 'turn.completed')).toHaveLength(2);
          expect(textEvents(observation.v1).join('\n')).toContain('Approval response: {"reply":"once"}');
        // bound: per-cell hang guard above driveRun's own 30 s settle bound, sized for a parity cell under host load.
        }, 45_000);

        // Through RunManager an accepted done keeps this session open briefly (hearsay-tools/squawk#1680):
        // the late card pends, its answer reaches the runner, and the step settles as the done said.
        for (const [where, steps] of [
          ['a non-final step', [{ id: 'first', name: 'First', prompt: '{{task}}' }, { id: 'second', name: 'Second', prompt: promptFor(backend, 'cezar-done') }]],
          ['the final step', [{ id: 'first', name: 'First', prompt: '{{task}}' }]],
        ] as const) {
          it(`${backend} P8 shows a late card after the done of ${where} and settles it done once the card is answered`, async () => {
            const workflowDef: WorkflowDef = { name: 'permission-late', source: 'built-in', steps: steps.map(step => ({ ...step })) };
            let repoRoot = '';
            let allowId = '';
            // bound: hang guard for the live mock run; the predicate waits on the run settling, and a stuck card fails here instead of at the test timeout.
            const observation = await driveRun(backend, 'permission-late', run => !!run && ['done', 'review'].includes(run.status), 30_000, undefined, {
              workflowDef,
              beforeStart: context => { repoRoot = context.repoRoot; },
              during: async ({ store, manager, runId }) => {
                await waitFor(() => store.readEvents(runId).some(event => event.type === 'permission.requested'));
                expect(store.getRun(runId)).toMatchObject({ status: RUN_STATUS.waiting, hasPendingPermission: true });
                expect(store.getRun(runId)?.steps.map(step => step.status)).toEqual(steps.map((_, index) => index === 0 ? STEP_STATUS.waiting : STEP_STATUS.pending));
                const request = store.readEvents(runId).find(event => event.type === 'permission.requested')!;
                allowId = (request.options as Array<{ id: string; label: string }>).find(option => option.label.toLowerCase().includes('allow once'))!.id;
                const response = await answerThroughRoute(repoRoot, store, manager, runId, request, allowId);
                expect(response.status).toBe(200);
                expect(await response.json()).toEqual({ delivered: true });
              },
            });
            expect(observation.record?.status).toBe('done');
            expect(observation.record?.hasPendingPermission).toBe(false);
            expect(observation.record?.steps.map(step => [step.id, step.status])).toEqual(steps.map(step => [step.id, 'done']));
            expect(permissionResolutionsOf(observation.events)).toEqual([expect.objectContaining({ optionId: allowId })]);
            expect(joinedText(observation.events)).toContain('Approval response: {"reply":"once"}');
          // bound: per-cell hang guard above driveRun's own 30 s settle bound, sized for a parity cell under host load.
          }, 45_000);
        }

        it(`${backend} P8 shows a late card after a Continue's done and settles it done once the card is answered`, async () => {
          let repoRoot = '';
          let allowId = '';
          // bound: hang guard for the live mock run; the predicate waits on the first session settling.
          const observation = await driveRun(backend, 'cezar-done', run => !!run && ['done', 'review'].includes(run.status), 30_000, async ({ store, manager, runId }) => {
            await waitFor(() => !manager.isActive(runId));
            expect(manager.continueRun(runId, { text: promptFor(backend, 'permission-late') })).toEqual({ ok: true });
            await waitFor(() => store.readEvents(runId).some(event => event.type === 'permission.requested'));
            expect(store.getRun(runId)).toMatchObject({ status: RUN_STATUS.waiting, hasPendingPermission: true });
            const request = store.readEvents(runId).find(event => event.type === 'permission.requested')!;
            allowId = (request.options as Array<{ id: string; label: string }>).find(option => option.label.toLowerCase().includes('allow once'))!.id;
            const response = await answerThroughRoute(repoRoot, store, manager, runId, request, allowId);
            expect(await response.json()).toEqual({ delivered: true });
            await waitFor(() => ['done', 'review'].includes(store.getRun(runId)?.status ?? '') && !manager.isActive(runId));
          }, { beforeStart: context => { repoRoot = context.repoRoot; } });
          expect(observation.record?.status).toBe('done');
          expect(observation.record?.hasPendingPermission).toBe(false);
          expect(permissionResolutionsOf(observation.events)).toEqual([expect.objectContaining({ optionId: allowId })]);
          expect(joinedText(observation.events)).toContain('Approval response: {"reply":"once"}');
        // bound: per-cell hang guard above driveRun's own 30 s settle bound, sized for a parity cell under host load.
        }, 60_000);

        // A human Finish still reaches the session that closes on its done, as it reaches an open one.
        it(`${backend} P8 Finish while a late card pends closes the session and settles the run done`, async () => {
          let repoRoot = '';
          // bound: hang guard for the live mock run; the predicate waits on the run settling, and a refused Finish fails here instead of at the test timeout.
          const observation = await driveRun(backend, 'permission-late', run => !!run && ['done', 'review'].includes(run.status), 30_000, undefined, {
            beforeStart: context => { repoRoot = context.repoRoot; },
            during: async ({ store, manager, runId }) => {
              await waitFor(() => store.readEvents(runId).some(event => event.type === 'permission.requested'));
              expect(store.getRun(runId)).toMatchObject({ status: RUN_STATUS.waiting, hasPendingPermission: true });
              expect(manager.finishBlockedReason(runId)).toBeUndefined();
              const response = await apiRequest(createApp({ home: testHome(), repoRoot, store, manager, version: 'test' }), `/api/v1/runs/${runId}/finish`, { method: 'POST' });
              expect(await response.json()).toEqual({ finished: true });
            },
          });
          expect(observation.record?.status).toBe('done');
          expect(observation.record?.hasPendingPermission).toBe(false);
          expect(permissionResolutionsOf(observation.events)).toEqual([expect.not.objectContaining({ optionId: expect.anything() })]);
          expect(observation.events).toContainEqual(expect.objectContaining({ type: 'lifecycle', message: 'session closed by user' }));
          expect(joinedText(observation.events)).not.toContain('Approval response');
        // bound: per-cell hang guard above driveRun's own 30 s settle bound, sized for a parity cell under host load.
        }, 45_000);
      }
    });
  },
} satisfies Readonly<Record<string, HarnessGroup>>;

/** Register the pending-request part's cells for one runner: `harness-<runner>-pending-request-parity.test.ts`. */
export function describeHarnessParity(scope: { runner: RunnerId; part: HarnessParityPart }, registration?: HarnessRegistration): void {
  describeHarnessPart('pending-request', PENDING_REQUEST_GROUPS, scope, registration);
}
