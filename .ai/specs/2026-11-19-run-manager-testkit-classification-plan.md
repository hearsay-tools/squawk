# Which RunManager testkit users need the real engine
Status: active

Scope: hearsay-tools/squawk#3938. This plan classifies every test file that reaches
`packages/cezar/src/workflows/run.ts` through a testkit, measures how much Squeal's
selection drops for each group, and proposes one child issue per group. It changes no test.

## Answer

On main `f60702641` (2026-11-19), 566 non-browser test files reach `workflows/run.ts`:
501 through a testkit, 53 by a direct import and 12 through a production module. The
issue counted 449 testkit users; the audit's graph (task `0a6c5807`) predates the moves
from direct imports into testkits since then.

- 67 of the 501 go through `server/run-manager.testkit.ts`, `delegation/service.testkit.ts`
  or `task-cli/cockpit.testkit.ts`. hearsay-tools/squawk#3937 covers them; they are listed
  here as `#3937` and not classified.
- Of the other 434: **345 need the real engine (A)**, **85 could be module tests (B)** and
  **4 repeat another test (C)**.
- 54 of the 85 B files never build a `RunManager`. They load the engine only because a
  helper, a row table or a teardown hook they import sits in an engine testkit. Moving
  those exports into engine-free files fixes them without changing any assertion.
- All B and C fixes together cut the weighted selection by **6.4% over 90 days** and
  **7.2% over 30 days**. The 54 import moves alone give 4.1% and 4.7%.
- The engine testkits are mostly honest. The 345 A files are parity cells and engine
  tests that drive a real session through waits, workers, restart and recovery.

## Classes

| Class | Meaning |
| --- | --- |
| A | Needs the real engine: the assertions depend on the run loop working with sessions, waits, workers, persistence or restart. A fake would remove the thing under test. |
| B | Could be a module test: what it asserts lives in one module; `RunManager` is only a harness, or is not used at all. |
| C | Repeats a test that already runs on the real engine. The row names that test. |
| #3937 | Out of scope: hearsay-tools/squawk#3937 gives these a run-engine fake. |

B splits by the fix it needs:

| Group | Fix |
| --- | --- |
| B-tables | A registration or static guard imports a row, group or partition table from a testkit that also imports the engine. Move the table into an engine-free rows module, as `workflows/ci-wait-failure-rows.testkit.ts` already does. |
| B-helper | The test imports one helper from an engine testkit: mostly `unused()` from `workflows/fixture-manager.testkit.ts` (reached through `fixture-no-runner.testkit.ts` and `run/boundary-order.testkit.ts`), also `buildDelegationCli` and `runnerHook`. Move the helper into its own testkit. |
| B-idle | The test builds a fixture manager that no assertion uses. Remove it. |
| B-teardown | `delegation/workspace-fixture.testkit.ts` imports `drainFixtureManagers` only for teardown. Split that teardown out; only `workspace-manager-recovery` needs it. |
| B-seam | Every cell calls `driveSeam` (runner adapter tier, no `RunManager`), but the cells live in an engine cell testkit. Move the seam cells into a seam-only testkit. |
| B-fake | The test builds the engine to check one module. Rewrite it against that module with a fake runner, store or manager. Many of these files mix classes: move the engine cases (listed in the details file) into their own A file. |

## Method

1. `graph.mjs` builds the import graph with Squeal's edge rules (value imports, `import()`,
   `require()`; no `import type`, no `vi.mock`). `squeal-data.mjs` reads Squeal's stored
   per-test inputs read-only. `model.mjs` joins them; on task `0a6c5807` this model matched
   Squeal's `.selection.testFiles` on 18 of 18 sample files.
2. `reach.mjs` takes the shortest import path from each test file to `workflows/run.ts`. The
   route is `testkit` when the first file on that path is a testkit.
3. Eight readers each read about 55 test files (432 files; the last 2, which Squeal walked later, were read separately) and their testkits, and gave each file one
   class with a one-line reason. A file that mixes classes takes the class of most of its
   tests; the other tests are listed per title in the details file. C needed the repeated
   test to be found by search. Spot checks against the code confirmed the `unused()`,
   workspace-teardown and registration-only claims.
4. `measure.mjs` computes the weighted cost: for every file, the first-parent commits on main
   that touched it in the window, times the edit and run-loop test files that select it.
   Browser specs are not counted. A B file keeps its production imports and the modules its
   row names, and drops every testkit import. A C file is deleted. The B numbers are an upper
   bound: a mixed file keeps its engine cases in a new file.

Rerun from the repository root, with a scratch directory outside the repository:

```sh
A=.ai/specs/assets/2026-11-19-run-manager-testkit-classification
node $A/graph.mjs . <scratch>/graph.json
node $A/squeal-data.mjs "$(git rev-parse --git-common-dir)/squeal/store.sqlite" "$PWD" <scratch>/squeal-data.json
node $A/reach.mjs <scratch> .
node $A/measure.mjs <scratch> . $A/rows.json
```

## Selection drop per group

Baseline weighted cost: 2,546,804 over 30 days and 3,603,349 over 90 days; 593 test files
select `workflows/run.ts` (566 by static imports; the rest through declared inputs, observed reads or stored node:test closures).

| Group | Files | Tests selecting `run.ts` after | Drop, 30 days | Drop, 90 days |
| --- | ---: | ---: | ---: | ---: |
| B-tables | 19 | 574 | 55,384 (2.2%) | 71,414 (2.0%) |
| B-helper | 18 | 575 | 24,661 (1.0%) | 29,766 (0.8%) |
| B-idle | 2 | 591 | 2,787 (0.1%) | 3,330 (0.1%) |
| B-teardown | 11 | 582 | 24,256 (1.0%) | 29,630 (0.8%) |
| B-seam | 4 | 589 | 12,039 (0.5%) | 15,152 (0.4%) |
| B-fake | 31 | 562 | 54,180 (2.1%) | 66,919 (1.9%) |
| C | 4 | 589 | 11,042 (0.4%) | 14,630 (0.4%) |
| All import moves (B except B-fake) | 54 | 539 | 119,127 (4.7%) | 149,292 (4.1%) |
| All B | 85 | 508 | 173,307 (6.8%) | 216,211 (6.0%) |
| All B and C | 89 | 504 | 184,349 (7.2%) | 230,841 (6.4%) |

Inside A files, readers also found 77 single tests that could be module tests (in 37 files)
and 10 single tests that repeat a parity cell. They are listed in the details file and are
not counted above.

## Proposed child issues

One issue per group the owner approves. Each issue changes tests and testkits only.

| # | Group | Issue scope | Drop, 90 days |
| --- | --- | --- | ---: |
| 1 | B-tables | Move the row, group and partition tables of 19 registration and static guards into engine-free rows modules | 2.0% |
| 2 | B-helper and B-idle | Move `unused()`, `buildDelegationCli` and `runnerHook` out of engine testkits; remove the two unused fixture managers | 0.9% |
| 3 | B-teardown | Split the manager teardown out of `delegation/workspace-fixture.testkit.ts` | 0.8% |
| 4 | B-seam | Move seam-only cells out of engine cell testkits (4 files, plus the seam cells inside mixed timeout and refusal files) | 0.4% |
| 5 | B-fake | Rewrite 31 engine-built tests as module tests with fakes, and split the mixed files | 1.9% |
| 6 | C | Delete the 4 repeated files and the 10 repeated single tests, after a reviewer confirms each repeat | 0.4% |

Issues 1 to 4 are import moves: no assertion changes. Issue 5 changes what each test drives.
Issue 6 removes coverage that another test keeps.

The reasons, the modules to call and the repeated tests for every B and C row are in
[`assets/2026-11-19-run-manager-testkit-classification/details.md`](assets/2026-11-19-run-manager-testkit-classification/details.md).

## Every test file

Paths are relative to `packages/cezar/src/`. Squeal group `loop` is run-loop. The testkit is
the first testkit on the shortest path to `workflows/run.ts`, without `.testkit.ts`.

| Test file | Squeal group | First testkit | Class |
| --- | --- | --- | --- |
| automations/automation-cli.test.ts | edit | task-cli/cockpit | #3937 |
| automations/task-template.test.ts | edit | workflows/fixture-no-runner | B-fake |
| core/codex-permission-recovery.test.ts | edit | core/workflow-parity | A |
| core/codex-provider-failure.test.ts | edit | core/workflow-parity | A |
| core/conversation-answer-delivery-declared-delivery.test.ts | edit | core/conversation-answer-delivery | A |
| core/conversation-answer-delivery-pending-question.test.ts | edit | core/conversation-answer-delivery | A |
| core/conversation-answer-delivery-registration.test.ts | edit | core/conversation-answer-delivery | B-tables |
| core/conversation-answer-delivery-steering.test.ts | edit | core/conversation-answer-delivery | A |
| core/conversation-batch-ack.test.ts | edit | core/workflow-parity | A |
| core/conversation-questions.test.ts | edit | core/workflow-parity | A |
| core/conversation-resume.test.ts | edit | core/workflow-parity | A |
| core/harness-autosave-settlement-cancel-continue.test.ts | edit | core/harness-autosave-settlement | A |
| core/harness-autosave-settlement-cancel.test.ts | edit | core/harness-autosave-settlement | A |
| core/harness-autosave-settlement-churn.test.ts | edit | core/harness-autosave-settlement | A |
| core/harness-autosave-settlement-failed-continue.test.ts | edit | core/harness-autosave-settlement | A |
| core/harness-autosave-settlement-success-continue.test.ts | edit | core/harness-autosave-settlement | A |
| core/harness-autosave-settlement-success.test.ts | edit | core/harness-autosave-settlement | A |
| core/harness-autosave-settlement.test.ts | edit | core/harness-autosave-settlement | A |
| core/harness-autosave.test.ts | edit | core/workflow-parity | A |
| core/harness-claude-owned-input-parity.test.ts | loop | core/harness-parity-owned-input.cells | A |
| core/harness-claude-owned-workflows-parity.test.ts | loop | core/harness-parity-owned-workflows.cells | A |
| core/harness-claude-ownership-parity.test.ts | loop | core/harness-parity-ownership.cells | A |
| core/harness-claude-pending-request-parity.test.ts | loop | core/harness-parity-pending-request.cells | B-seam |
| core/harness-claude-provider-parity.test.ts | loop | core/harness-parity-provider.cells | A |
| core/harness-claude-run-parity.test.ts | loop | core/harness-parity-run.cells | A |
| core/harness-claude-settlement-parity.test.ts | loop | core/harness-parity-settlement.cells | A |
| core/harness-codex-owned-input-parity.test.ts | loop | core/harness-parity-owned-input.cells | A |
| core/harness-codex-owned-workflows-parity.test.ts | loop | core/harness-parity-owned-workflows.cells | A |
| core/harness-codex-ownership-parity.test.ts | loop | core/harness-parity-ownership.cells | A |
| core/harness-codex-pending-request-parity.test.ts | loop | core/harness-parity-pending-request.cells | A |
| core/harness-codex-provider-parity.test.ts | loop | core/harness-parity-provider.cells | A |
| core/harness-codex-run-parity.test.ts | loop | core/harness-parity-run.cells | A |
| core/harness-codex-settlement-parity.test.ts | loop | core/harness-parity-settlement.cells | A |
| core/harness-omp-owned-input-parity.test.ts | loop | core/harness-parity-owned-input.cells | A |
| core/harness-omp-owned-workflows-parity.test.ts | loop | core/harness-parity-owned-workflows.cells | A |
| core/harness-omp-ownership-parity.test.ts | loop | core/harness-parity-ownership.cells | A |
| core/harness-omp-pending-request-parity.test.ts | loop | core/harness-parity-pending-request.cells | B-seam |
| core/harness-omp-provider-parity.test.ts | loop | core/harness-parity-provider.cells | A |
| core/harness-omp-run-parity.test.ts | loop | core/harness-parity-run.cells | A |
| core/harness-omp-settlement-parity.test.ts | loop | core/harness-parity-settlement.cells | A |
| core/harness-opencode-owned-input-parity.test.ts | loop | core/harness-parity-owned-input.cells | A |
| core/harness-opencode-owned-workflows-parity.test.ts | loop | core/harness-parity-owned-workflows.cells | A |
| core/harness-opencode-ownership-parity.test.ts | loop | core/harness-parity-ownership.cells | A |
| core/harness-opencode-pending-request-parity.test.ts | loop | core/harness-parity-pending-request.cells | A |
| core/harness-opencode-provider-parity.test.ts | loop | core/harness-parity-provider.cells | A |
| core/harness-opencode-run-parity.test.ts | loop | core/harness-parity-run.cells | A |
| core/harness-opencode-settlement-parity.test.ts | loop | core/harness-parity-settlement.cells | A |
| core/harness-parity.test.ts | loop | core/harness-autosave-settlement | A |
| core/harness-pi-owned-input-parity.test.ts | loop | core/harness-parity-owned-input.cells | A |
| core/harness-pi-owned-workflows-parity.test.ts | loop | core/harness-parity-owned-workflows.cells | A |
| core/harness-pi-ownership-parity.test.ts | loop | core/harness-parity-ownership.cells | A |
| core/harness-pi-pending-request-parity.test.ts | loop | core/harness-parity-pending-request.cells | B-seam |
| core/harness-pi-provider-parity.test.ts | loop | core/harness-parity-provider.cells | A |
| core/harness-pi-run-parity.test.ts | loop | core/harness-parity-run.cells | A |
| core/harness-pi-settlement-parity.test.ts | loop | core/harness-parity-settlement.cells | A |
| core/model-refusal-parity.test.ts | loop | core/workflow-parity | B-fake |
| core/owned-attach-placement.test.ts | edit | delegation/service | #3937 |
| core/owned-input-delivery-opencode-ack.test.ts | edit | core/workflow-parity | A |
| core/owned-input-delivery-opencode-failure.test.ts | edit | core/workflow-parity | A |
| core/owned-input-delivery-port-collision.test.ts | edit | core/workflow-parity | B-fake |
| core/owned-input-delivery-provider-failure.test.ts | edit | core/workflow-parity | A |
| core/owned-input-delivery-rejection.test.ts | edit | core/workflow-parity | A |
| core/owned-input-delivery-settlement.test.ts | edit | workflows/fixture-cleanup | A |
| core/owned-input-delivery.test.ts | edit | workflows/fixture-cleanup | A |
| core/owned-input-failure.test.ts | edit | core/workflow-parity | A |
| core/parity-classes.test.ts | loop | core/harness-parity-cells | B-tables |
| core/skill-provision-continue-parity.test.ts | loop | core/skill-provision-parity | B-fake |
| core/skill-provision-recovery-parity.test.ts | loop | core/skill-provision-parity | B-fake |
| core/skill-provision-registration-parity.test.ts | loop | core/skill-provision-parity | B-tables |
| core/skill-provision-slash-install-parity.test.ts | loop | core/skill-provision-parity | A |
| core/skill-provision-start-and-stop-parity.test.ts | loop | core/skill-provision-parity | A |
| core/skill-resume-live-continue-claude-pi-parity.test.ts | loop | core/skill-resume-parity | A |
| core/skill-resume-live-continue-codex-omp-parity.test.ts | loop | core/skill-resume-parity | A |
| core/skill-resume-live-continue-opencode-parity.test.ts | loop | core/skill-resume-parity | A |
| core/skill-resume-recovery-before-session-event-parity.test.ts | loop | core/skill-resume-parity | A |
| core/skill-resume-recovery-prompt-parity.test.ts | loop | core/skill-resume-parity | A |
| core/skill-resume-registration-parity.test.ts | loop | core/skill-resume-parity | B-tables |
| core/skill-resume-session-identity-claude-pi-parity.test.ts | loop | core/skill-resume-parity | A |
| core/skill-resume-session-identity-codex-omp-parity.test.ts | loop | core/skill-resume-parity | A |
| core/skill-resume-session-identity-opencode-parity.test.ts | loop | core/skill-resume-parity | A |
| core/skill-resume-wire-and-fallback-parity.test.ts | loop | core/skill-resume-parity | B-fake |
| core/unread-input.test.ts | edit | workflows/fixture-manager | A |
| core/workflow-ask-cancel-parity.test.ts | loop | core/workflow-ask-cells | A |
| core/workflow-ask-continue-parity.test.ts | loop | core/workflow-ask-cells | A |
| core/workflow-ask-parity.test.ts | loop | core/workflow-ask-cells | B-tables |
| core/workflow-ask-restart-parity.test.ts | loop | core/workflow-ask-cells | A |
| core/workflow-ask-timeout-parity.test.ts | loop | core/workflow-ask-cells | A |
| core/workflow-autonomous-ack-bound-parity.test.ts | loop | core/workflow-autonomous-parity | A |
| core/workflow-autonomous-answer-bound-parity.test.ts | loop | core/workflow-autonomous-parity | A |
| core/workflow-autonomous-ask-refusal-parity.test.ts | loop | core/workflow-autonomous-parity | A |
| core/workflow-autonomous-budget-continuation-parity.test.ts | loop | core/workflow-autonomous-parity | A |
| core/workflow-autonomous-budget-fresh-parity.test.ts | loop | core/workflow-autonomous-parity | A |
| core/workflow-autonomous-idle-close-continuation-parity.test.ts | loop | core/workflow-autonomous-parity | A |
| core/workflow-autonomous-idle-close-fresh-parity.test.ts | loop | core/workflow-autonomous-parity | A |
| core/workflow-autonomous-late-readiness-continuation-parity.test.ts | loop | core/workflow-autonomous-parity | A |
| core/workflow-autonomous-late-readiness-fresh-parity.test.ts | loop | core/workflow-autonomous-parity | A |
| core/workflow-autonomous-native-questions-parity.test.ts | loop | core/workflow-autonomous-parity | A |
| core/workflow-autonomous-non-autonomous-parity.test.ts | loop | core/workflow-autonomous-parity | A |
| core/workflow-autonomous-nudges-parity.test.ts | loop | core/workflow-autonomous-parity | A |
| core/workflow-autonomous-registration-parity.test.ts | loop | core/workflow-autonomous-parity | B-tables |
| core/workflow-autonomous-tool-parking-parity.test.ts | loop | core/workflow-autonomous-parity | A |
| core/workflow-autonomous-unanswered-question-parity.test.ts | loop | core/workflow-autonomous-parity | A |
| core/workflow-final-message-ack-delay-parity.test.ts | loop | core/workflow-final-message-cells | A |
| core/workflow-final-message-content-budget-parity.test.ts | loop | core/workflow-final-message-cells | A |
| core/workflow-final-message-late-reply-parity.test.ts | loop | core/workflow-final-message-cells | A |
| core/workflow-final-message-parity.test.ts | loop | core/workflow-final-message-cells | B-tables |
| core/workflow-final-message-reply-bound-parity.test.ts | loop | core/workflow-final-message-cells | A |
| core/workflow-final-message-silent-tail-parity.test.ts | loop | core/workflow-final-message-cells | B-seam |
| core/workflow-followup-codex-admission-parity.test.ts | loop | core/workflow-followup-cells | A |
| core/workflow-followup-codex-coalesced-parity.test.ts | loop | core/workflow-followup-cells | A |
| core/workflow-followup-codex-delayed-start-parity.test.ts | loop | core/workflow-followup-cells | A |
| core/workflow-followup-codex-reverse-order-parity.test.ts | loop | core/workflow-followup-cells | A |
| core/workflow-followup-hold-parity.test.ts | loop | core/workflow-followup-cells | A |
| core/workflow-followup-late-ack-continuation-parity.test.ts | loop | core/workflow-followup-cells | A |
| core/workflow-followup-late-ack-fresh-parity.test.ts | loop | core/workflow-followup-cells | A |
| core/workflow-followup-late-start-continuation-parity.test.ts | loop | core/workflow-followup-cells | A |
| core/workflow-followup-late-start-fresh-parity.test.ts | loop | core/workflow-followup-cells | A |
| core/workflow-followup-parity.test.ts | loop | core/workflow-followup-cells | B-tables |
| core/workflow-followup-turn-end-parity.test.ts | loop | core/workflow-followup-cells | A |
| core/workflow-no-progress-continue-steer-parity.test.ts | loop | core/workflow-no-progress-parity | A |
| core/workflow-no-progress-parked-input-parity.test.ts | loop | core/workflow-no-progress-parity | A |
| core/workflow-no-progress-process-exit-parity.test.ts | loop | core/workflow-no-progress-parity | A |
| core/workflow-no-progress-progress-parity.test.ts | loop | core/workflow-no-progress-parity | A |
| core/workflow-no-progress-registration-parity.test.ts | loop | core/workflow-no-progress-parity | B-tables |
| core/workflow-step-completion-autonomous-parity.test.ts | loop | core/workflow-step-completion-parity | A |
| core/workflow-step-completion-clean-close-parity.test.ts | loop | core/workflow-step-completion-parity | A |
| core/workflow-step-completion-idle-close-parity.test.ts | loop | core/workflow-step-completion-parity | A |
| core/workflow-step-completion-no-done-parity.test.ts | loop | core/workflow-step-completion-parity | A |
| core/workflow-step-completion-recovery-parity.test.ts | loop | core/workflow-step-completion-parity | A |
| core/workflow-step-completion-registration-parity.test.ts | loop | core/workflow-step-completion-parity | B-tables |
| core/workflow-step-completion-setup-failure-parity.test.ts | loop | core/workflow-step-completion-parity | A |
| core/workflow-timeout-authored-and-standalone-parity.test.ts | loop | core/workflow-timeout-parity | B-fake |
| core/workflow-timeout-defaults-parity.test.ts | loop | core/workflow-timeout-parity | A |
| core/workflow-timeout-explicit-zero-parity.test.ts | loop | core/workflow-timeout-parity | B-fake |
| core/workflow-timeout-registration-parity.test.ts | loop | core/workflow-timeout-parity | B-tables |
| core/worktree-setup-parity.test.ts | loop | core/workflow-parity | A |
| delegation/cli.test.ts | edit | delegation/service | #3937 |
| delegation/context.test.ts | edit | delegation/service | #3937 |
| delegation/conversation-effects.test.ts | edit | delegation/service | #3937 |
| delegation/conversation-scope-order.test.ts | edit | delegation/service | #3937 |
| delegation/conversation-service.test.ts | edit | delegation/service | #3937 |
| delegation/destruction-results.test.ts | edit | workflows/fixture-claude | #3937 |
| delegation/discovery.test.ts | edit | delegation/service | #3937 |
| delegation/execution-settings.test.ts | edit | delegation/service | #3937 |
| delegation/explicit-comparison.test.ts | edit | delegation/service | #3937 |
| delegation/family-end.test.ts | edit | delegation/workspace-fixture | B-teardown |
| delegation/message-cli.test.ts | edit | delegation/service | #3937 |
| delegation/peer-conversations.test.ts | edit | delegation/service | #3937 |
| delegation/provision-accepted-grants.test.ts | edit | workflows/fixture-cleanup | A |
| delegation/provision-accounts-lifecycle.test.ts | edit | server/run-manager | #3937 |
| delegation/provision-claude-layouts.test.ts | edit | delegation/provision-workflows | A |
| delegation/provision-input-recipes.test.ts | edit | delegation/provision-workflows | A |
| delegation/provision-intent-catalog.test.ts | edit | delegation/provision-workflows | A |
| delegation/provision-matrix-registration.test.ts | edit | delegation/provision-workflows | B-tables |
| delegation/provision-step-identity.test.ts | edit | workflows/fixture-cleanup | A |
| delegation/provision.test.ts | edit | delegation/service | #3937 |
| delegation/results.test.ts | edit | delegation/service | #3937 |
| delegation/resume-admission.test.ts | edit | delegation/service | #3937 |
| delegation/routes.test.ts | edit | workflows/fixture-claude | #3937 |
| delegation/scratch-cleanup.test.ts | edit | workflows/worker-wait-claude | B-fake |
| delegation/service-destroy-cadence.test.ts | edit | delegation/service | #3937 |
| delegation/service-destroy-holder.test.ts | edit | workflows/fixture-claude | B-fake |
| delegation/service-destroy-recovery.test.ts | edit | workflows/fixture-claude | #3937 |
| delegation/service-destroy-topology-repair.test.ts | edit | delegation/service-destroy-backoff | #3937 |
| delegation/service-destroy-work.test.ts | edit | delegation/service-destroy-backoff | #3937 |
| delegation/service-fixture.test.ts | edit | delegation/service | #3937 |
| delegation/service-repository-seed.test.ts | edit | delegation/service | #3937 |
| delegation/service-shared-workspace.test.ts | edit | delegation/service | #3937 |
| delegation/service-supervised-worker.test.ts | edit | delegation/service | #3937 |
| delegation/service.test.ts | edit | workflows/fixture-cleanup | #3937 |
| delegation/service.testkit.test.ts | edit | delegation/service | #3937 |
| delegation/settled-observation.test.ts | edit | delegation/service | #3937 |
| delegation/task-access.test.ts | edit | delegation/service | #3937 |
| delegation/task-discovery-page.test.ts | edit | delegation/service | #3937 |
| delegation/task-discovery.test.ts | edit | delegation/service | #3937 |
| delegation/workspace-destruction-bookkeeping.test.ts | edit | delegation/workspace-fixture | B-teardown |
| delegation/workspace-destruction-gc.test.ts | edit | delegation/workspace-fixture | B-teardown |
| delegation/workspace-destruction-identity.test.ts | edit | delegation/workspace-fixture | B-teardown |
| delegation/workspace-destruction-recovery.test.ts | edit | delegation/workspace-fixture | B-teardown |
| delegation/workspace-destruction-refs.test.ts | edit | delegation/workspace-fixture | B-teardown |
| delegation/workspace-diff.test.ts | edit | delegation/workspace-fixture | B-teardown |
| delegation/workspace-generic-cleanup.test.ts | edit | delegation/workspace-fixture | B-teardown |
| delegation/workspace-manager-recovery.test.ts | edit | workflows/fixture-claude | A |
| delegation/workspace-removal-witness.test.ts | edit | delegation/workspace-fixture | B-teardown |
| delegation/workspace-removal-work.test.ts | edit | delegation/workspace-fixture | B-teardown |
| delegation/workspace.test.ts | edit | delegation/workspace-fixture | B-teardown |
| discovery/cli.test.ts | edit | delegation/service | #3937 |
| project-migration/engine-crash-rewrites.test.ts | edit | server/run-manager | #3937 |
| project-migration/moved-project.test.ts | edit | server/run-manager | #3937 |
| runs/store-history-compression.test.ts | edit | workflows/fixture-manager | B-fake |
| server/artifacts-api.test.ts | edit | server/run-manager | #3937 |
| server/automations-api.test.ts | edit | server/run-manager | #3937 |
| server/checkout.test.ts | edit | server/run-manager | #3937 |
| server/cockpit-address.test.ts | edit | server/run-manager | #3937 |
| server/cockpit-ownership.test.ts | edit | server/run-manager | #3937 |
| server/delegation-cleanup.test.ts | edit | delegation/service | #3937 |
| server/finishability.test.ts | edit | workflows/worker-wait | A |
| server/project-context-maintenance.test.ts | edit | server/run-manager | #3937 |
| server/project-context-repo-handle.test.ts | edit | server/run-manager | #3937 |
| server/project-context-sweep.test.ts | edit | server/run-manager | #3937 |
| server/project-context.test.ts | edit | server/run-manager | #3937 |
| server/project-warmup.test.ts | edit | server/run-manager | #3937 |
| server/provider-action-gating.test.ts | edit | workflows/fixture-cleanup | B-fake |
| server/providers-api.test.ts | edit | server/run-manager | #3937 |
| server/restart-shutdown.test.ts | edit | server/run-manager | #3937 |
| server/route-parity.test.ts | loop | server/run-manager | #3937 |
| server/run-relationships.test.ts | edit | delegation/service | #3937 |
| server/run-store-unavailable.test.ts | edit | server/run-manager | #3937 |
| server/task-webhook-api.test.ts | edit | server/run-manager | #3937 |
| server/usage-scope.test.ts | edit | server/run-manager | #3937 |
| server/workspace-events.test.ts | edit | server/run-manager | #3937 |
| server/worktrees-api.test.ts | edit | workflows/fixture-claude | B-fake |
| task-cli/cli-actions.test.ts | edit | task-cli/cli | #3937 |
| task-cli/cli-arguments-positionals.test.ts | edit | task-cli/cli | #3937 |
| task-cli/cli-arguments-values.test.ts | edit | task-cli/cli | #3937 |
| task-cli/cli-arguments.test.ts | edit | task-cli/cli | #3937 |
| task-cli/cli-queries.test.ts | edit | task-cli/cli | #3937 |
| task-cli/cli-results.test.ts | edit | task-cli/cli | #3937 |
| task-cli/cli-usage.test.ts | edit | task-cli/cli | #3937 |
| task-cli/cli.test.ts | edit | task-cli/cli | #3937 |
| task-cli/status-question.test.ts | edit | task-cli/cockpit | #3937 |
| task-cli/watch.test.ts | edit | task-cli/cockpit | #3937 |
| workflows/agent-profile-wiring.test.ts | edit | workflows/fixture-cleanup | B-idle |
| workflows/agent-webhooks-prompt.test.ts | edit | workflows/fixture-manager | B-fake |
| workflows/automation-tools-claude-parity.test.ts | loop | workflows/automation-tools-parity | A |
| workflows/automation-tools-codex-parity.test.ts | loop | workflows/automation-tools-parity | A |
| workflows/automation-tools-omp-parity.test.ts | loop | workflows/automation-tools-parity | A |
| workflows/automation-tools-opencode-parity.test.ts | loop | workflows/automation-tools-parity | A |
| workflows/automation-tools-pi-parity.test.ts | loop | workflows/automation-tools-parity | A |
| workflows/automation-tools.test.ts | edit | workflows/fixture-no-runner | B-fake |
| workflows/automations-prompt.test.ts | edit | workflows/fixture-manager | A |
| workflows/autosave-report.test.ts | edit | workflows/fixture-claude | B-helper |
| workflows/boundary-launch-order.test.ts | edit | workflows/run-fixture | A |
| workflows/check-stop-kill.test.ts | edit | workflows/fixture-claude | A |
| workflows/ci-wait-conflict-continued-parity.test.ts | loop | workflows/ci-wait-conflict-parity | A |
| workflows/ci-wait-conflict-fresh-parity.test.ts | loop | workflows/ci-wait-conflict-parity | A |
| workflows/ci-wait-conflict-parity.test.ts | loop | workflows/ci-wait-conflict-parity | B-tables |
| workflows/ci-wait-conflict-recovered-parity.test.ts | loop | workflows/ci-wait-conflict-parity | A |
| workflows/ci-wait-delivery.test.ts | edit | workflows/worker-wait | A |
| workflows/ci-wait-final-recovery-parity.test.ts | loop | workflows/ci-wait-failure-parity | A |
| workflows/ci-wait-lifecycle-registration.test.ts | edit | workflows/worker-wait-claude | A |
| workflows/ci-wait-list-recovery.test.ts | edit | workflows/worker-wait-claude | A |
| workflows/ci-wait-list-registration.test.ts | edit | workflows/worker-wait-claude | B-fake |
| workflows/ci-wait-native-activity.test.ts | edit | workflows/worker-wait | A |
| workflows/ci-wait-nonfinal-failed-parity.test.ts | loop | workflows/ci-wait-failure-parity | A |
| workflows/ci-wait-nonfinal-passed-parity.test.ts | loop | workflows/ci-wait-failure-parity | A |
| workflows/ci-wait-nonfinal-restarted-parity.test.ts | loop | workflows/ci-wait-failure-parity | A |
| workflows/ci-wait-nonfinal-source-retry-parity.test.ts | loop | workflows/ci-wait-failure-parity | A |
| workflows/ci-wait-refusal.test.ts | edit | workflows/worker-wait | A |
| workflows/ci-wait-registration.test.ts | edit | workflows/worker-wait | B-fake |
| workflows/ci-wait-rerun-fresh-parity.test.ts | loop | workflows/ci-wait-rerun-parity | A |
| workflows/ci-wait-rerun-parity.test.ts | loop | workflows/ci-wait-rerun-parity | B-tables |
| workflows/ci-wait-rerun-recovered-parity.test.ts | loop | workflows/ci-wait-rerun-parity | A |
| workflows/ci-wait-restart-acknowledgement-parity.test.ts | loop | workflows/ci-wait-failure-parity | A |
| workflows/ci-wait-restart-queued-tail-parity.test.ts | loop | workflows/ci-wait-failure-parity | A |
| workflows/ci-wait-retry-parity.test.ts | loop | workflows/worker-wait | A |
| workflows/ci-wait-retry.test.ts | edit | workflows/worker-wait | A |
| workflows/ci-wait.test.ts | edit | workflows/worker-wait-claude | A |
| workflows/completion-gate-entry.test.ts | edit | workflows/fixture-cleanup | B-fake |
| workflows/context-completion-registration-parity.test.ts | loop | workflows/worker-wait | B-tables |
| workflows/continuation-tools.test.ts | edit | workflows/fixture-manager | A |
| workflows/continue-unarchive.test.ts | edit | workflows/fixture-manager | B-fake |
| workflows/conversation-batch.test.ts | edit | workflows/worker-wait | A |
| workflows/conversation-resume-wait.test.ts | edit | workflows/worker-wait | A |
| workflows/dead-owner-claims.test.ts | edit | workflows/fixture-no-runner | A |
| workflows/delegation-integration-cli.test.ts | edit | workflows/delegation-integration | B-helper |
| workflows/delegation-integration-failure-authority.test.ts | edit | workflows/delegation-integration | A |
| workflows/delegation-integration-parent-cancellation.test.ts | edit | workflows/delegation-integration | A |
| workflows/delegation-integration-reviewed-integration.test.ts | edit | workflows/delegation-integration | A |
| workflows/delegation-integration-spawn-idempotency.test.ts | edit | workflows/delegation-integration | B-fake |
| workflows/done-accepted.test.ts | edit | workflows/waits-parity-fixture | A |
| workflows/execution-account.test.ts | edit | workflows/fixture-manager | B-fake |
| workflows/failed-continue-workflow-resume.test.ts | edit | workflows/fixture-claude | A |
| workflows/held-human-input-liveness.test.ts | edit | workflows/fixture-cleanup | A |
| workflows/immediate-delivery.test.ts | edit | workflows/worker-wait | A |
| workflows/input-entry-state.test.ts | edit | workflows/run-fixture | B-fake |
| workflows/input-receipt-boundaries.test.ts | edit | workflows/fixture-manager | #3937 |
| workflows/launch-disposal-routes.test.ts | edit | workflows/fixture-cleanup | #3937 |
| workflows/launch-read-boundaries.test.ts | edit | workflows/fixture-cleanup | A |
| workflows/launch-system-prompt.test.ts | edit | workflows/fixture-manager | A |
| workflows/liveness-scope.test.ts | edit | workflows/run-fixture | A |
| workflows/maintenance-claims.test.ts | edit | workflows/fixture-no-runner | B-fake |
| workflows/model-identity-wiring.test.ts | edit | workflows/fixture-cleanup | A |
| workflows/monitoring-turn-ask-ack.test.ts | edit | workflows/monitoring-turn-rows | A |
| workflows/monitoring-turn-ask-idle-closure-continuation.test.ts | edit | workflows/monitoring-turn-rows | A |
| workflows/monitoring-turn-ask-idle-closure-fresh.test.ts | edit | workflows/monitoring-turn-rows | A |
| workflows/monitoring-turn-ask-precedence-done-refusal-continuation.test.ts | edit | workflows/monitoring-turn-rows | A |
| workflows/monitoring-turn-ask-precedence-done-refusal-fresh.test.ts | edit | workflows/monitoring-turn-rows | A |
| workflows/monitoring-turn-ask-precedence-question-continuation.test.ts | edit | workflows/monitoring-turn-rows | A |
| workflows/monitoring-turn-ask-precedence-question-fresh.test.ts | edit | workflows/monitoring-turn-rows | A |
| workflows/monitoring-turn-autonomous-prose-continuation.test.ts | edit | workflows/monitoring-turn-rows | A |
| workflows/monitoring-turn-autonomous-prose-fresh.test.ts | edit | workflows/monitoring-turn-rows | A |
| workflows/monitoring-turn-close.test.ts | edit | workflows/monitoring-turn-rows | A |
| workflows/monitoring-turn-done-continuation.test.ts | edit | workflows/monitoring-turn-rows | A |
| workflows/monitoring-turn-done-fresh.test.ts | edit | workflows/monitoring-turn-rows | A |
| workflows/monitoring-turn-prose-question-continuation.test.ts | edit | workflows/monitoring-turn-rows | A |
| workflows/monitoring-turn-prose-question-fresh.test.ts | edit | workflows/monitoring-turn-rows | A |
| workflows/monitoring-turn-timer-continuation.test.ts | edit | workflows/monitoring-turn-rows | A |
| workflows/monitoring-turn-timer-fresh.test.ts | edit | workflows/monitoring-turn-rows | A |
| workflows/monitoring-turn-worker-review-done-continuation.test.ts | edit | workflows/monitoring-turn-rows | A |
| workflows/monitoring-turn-worker-review-fresh.test.ts | edit | workflows/monitoring-turn-rows | A |
| workflows/monitoring-turn-worker-review-request-continuation.test.ts | edit | workflows/monitoring-turn-rows | A |
| workflows/native-ask-release-order.test.ts | edit | workflows/run-fixture | A |
| workflows/native-session-continue.test.ts | edit | workflows/fixture-cleanup | A |
| workflows/native-skill-input.test.ts | edit | workflows/fixture-cleanup | A |
| workflows/native-skill-recovery.test.ts | edit | workflows/fixture-cleanup | A |
| workflows/pasted-attachments-continue.test.ts | edit | workflows/fixture-cleanup | A |
| workflows/permissions.test.ts | edit | workflows/fixture-cleanup | A |
| workflows/pr-merge-wait-parity.test.ts | loop | workflows/worker-wait | A |
| workflows/prelaunch-cancel.test.ts | edit | workflows/fixture-claude | A |
| workflows/process-waits.test.ts | edit | workflows/worker-wait-claude | A |
| workflows/recover-autonomous.test.ts | edit | workflows/fixture-cleanup | A |
| workflows/recover-followups.test.ts | edit | workflows/fixture-no-runner | B-fake |
| workflows/recover-session-failure.test.ts | edit | workflows/fixture-cleanup | A |
| workflows/recovery-order.test.ts | edit | workflows/fixture-claude | A |
| workflows/removed-project-root.test.ts | edit | workflows/fixture-manager | A |
| workflows/removed-runner-continue.test.ts | edit | workflows/fixture-manager | A |
| workflows/repo-rediscovery.test.ts | edit | workflows/fixture-no-runner | A |
| workflows/request-completion.test.ts | edit | workflows/worker-wait | A |
| workflows/resume-diagnostics-failure-context-parity.test.ts | loop | workflows/resume-diagnostics | A |
| workflows/resume-diagnostics-human-text-parity.test.ts | loop | workflows/resume-diagnostics | A |
| workflows/resume-diagnostics-registration-parity.test.ts | loop | workflows/resume-diagnostics | B-tables |
| workflows/resume-diagnostics-restart-context-parity.test.ts | loop | workflows/resume-diagnostics | A |
| workflows/resume-diagnostics-saved-continuation-parity.test.ts | loop | workflows/resume-diagnostics | A |
| workflows/retention-wiring.test.ts | edit | workflows/fixture-claude | A |
| workflows/run-continuation-membership.test.ts | edit | workflows/worker-wait-readiness | A |
| workflows/run-continue-recovery.test.ts | edit | workflows/fixture-cleanup | B-fake |
| workflows/run-fixture.test.ts | edit | workflows/run-fixture | B-helper |
| workflows/run-idle-close.test.ts | edit | workflows/worker-wait-readiness | A |
| workflows/run-isolation.test.ts | edit | workflows/fixture-claude | A |
| workflows/run-lease.test.ts | edit | workflows/fixture-claude | A |
| workflows/run-memory-release.test.ts | edit | workflows/fixture-cleanup | A |
| workflows/run-monitoring-asks-cost.test.ts | edit | workflows/fixture-cleanup | A |
| workflows/run-monitoring-reply.test.ts | edit | workflows/run-fixture | A |
| workflows/run-monitoring-timers.test.ts | edit | workflows/fixture-cleanup | A |
| workflows/run-preview.test.ts | edit | workflows/fixture-manager | A |
| workflows/run-schedule-wakeup.test.ts | edit | workflows/run-fixture | A |
| workflows/run-settlement.test.ts | edit | workflows/fixture-cleanup | B-fake |
| workflows/run-states-model.test.ts | edit | workflows/worker-wait-readiness | A |
| workflows/run-states-worker.test.ts | edit | workflows/worker-wait-readiness | A |
| workflows/run-waiting-publication.test.ts | edit | workflows/run-fixture | A |
| workflows/run-workflow-remainder-resume.test.ts | edit | workflows/worker-wait-readiness | A |
| workflows/run-workflow-restart.test.ts | edit | workflows/worker-wait-readiness | A |
| workflows/run/boundary-family-reconciliation.test.ts | edit | workflows/fixture-no-runner | B-helper |
| workflows/run/completion-wait-capacity.test.ts | edit | workflows/fixture-no-runner | B-helper |
| workflows/run/done-accepted.test.ts | edit | workflows/run/boundary-input-order | B-helper |
| workflows/run/family-reconciler-scratch.test.ts | edit | workflows/fixture-no-runner | B-helper |
| workflows/run/human-waits.test.ts | edit | workflows/fixture-no-runner | B-helper |
| workflows/run/native-input-queue.test.ts | edit | workflows/fixture-no-runner | B-helper |
| workflows/run/run-settlement-branch-sweep.test.ts | edit | workflows/fixture-no-runner | B-idle |
| workflows/run/session-fault.test.ts | edit | workflows/run-fixture | B-fake |
| workflows/run/turn-boundary-adapter-order.test.ts | edit | workflows/fixture-no-runner | B-helper |
| workflows/run/turn-boundary-input-order.test.ts | edit | workflows/run/boundary-input-order | B-helper |
| workflows/run/turn-boundary-session-order.test.ts | edit | workflows/fixture-no-runner | B-helper |
| workflows/run/turn-boundary-timer-order.test.ts | edit | workflows/fixture-no-runner | B-helper |
| workflows/run/turn-boundary-worker-order.test.ts | edit | workflows/fixture-no-runner | B-helper |
| workflows/run/turn-boundary.test.ts | edit | workflows/fixture-no-runner | B-helper |
| workflows/run/turn-nudges-decisions.test.ts | edit | workflows/fixture-no-runner | A |
| workflows/run/turn-settler.test.ts | edit | workflows/fixture-no-runner | B-helper |
| workflows/run/wait-engine.test.ts | edit | workflows/fixture-no-runner | B-helper |
| workflows/runner-load-stop.test.ts | edit | workflows/fixture-claude | A |
| workflows/scoped-recovery.test.ts | edit | workflows/worker-wait-claude | A |
| workflows/session-context-live-parity.test.ts | loop | workflows/session-context-cells | A |
| workflows/session-context-opening-parity.test.ts | loop | workflows/session-context-cells | A |
| workflows/session-context-parity.test.ts | loop | workflows/session-context-cells | A |
| workflows/session-context-recovery-parity.test.ts | loop | workflows/session-context-cells | A |
| workflows/session-context-worker-parity.test.ts | loop | workflows/session-context-cells | A |
| workflows/skill-resume-continuation.test.ts | edit | workflows/fixture-cleanup | A |
| workflows/slot-release-return-boundary.test.ts | edit | workflows/run-fixture | A |
| workflows/stopped-composer.test.ts | edit | workflows/fixture-manager | A |
| workflows/supervised-worker-recovery.test.ts | edit | workflows/worker-wait-claude | A |
| workflows/team-skill-materialize.test.ts | edit | workflows/fixture-cleanup | A |
| workflows/tool-activity-wiring.test.ts | edit | workflows/fixture-cleanup | A |
| workflows/turn-path-fact-values.test.ts | edit | workflows/run-fixture | B-fake |
| workflows/unread-liveness.test.ts | edit | workflows/worker-wait-claude | A |
| workflows/usage-limit-worker-continue.test.ts | edit | workflows/worker-wait-claude | A |
| workflows/wait-registration-effects.test.ts | edit | workflows/worker-wait-claude | B-fake |
| workflows/waits-claude-answers-parity.test.ts | loop | workflows/waits-parity-answers-cells | A |
| workflows/waits-claude-asks-parity.test.ts | loop | workflows/waits-parity-asks-cells | A |
| workflows/waits-claude-closed-bound-parity.test.ts | loop | workflows/waits-parity-closed-cells | A |
| workflows/waits-claude-closed-continue-parity.test.ts | loop | workflows/waits-parity-closed-cells | A |
| workflows/waits-claude-closed-resume-parity.test.ts | loop | workflows/waits-parity-closed-cells | A |
| workflows/waits-claude-completion-parity.test.ts | loop | workflows/waits-parity-completion-cells | A |
| workflows/waits-claude-completion-replies-parity.test.ts | loop | workflows/waits-parity-completion-replies-cells | A |
| workflows/waits-claude-conversations-parity.test.ts | loop | workflows/waits-parity-conversations-cells | A |
| workflows/waits-claude-deadlines-parity.test.ts | loop | workflows/waits-parity-deadlines-cells | A |
| workflows/waits-claude-delivery-parity.test.ts | loop | workflows/waits-parity-delivery-cells | A |
| workflows/waits-claude-done-parity.test.ts | loop | workflows/waits-parity-done-cells | A |
| workflows/waits-claude-entries-parity.test.ts | loop | workflows/waits-parity-entries-cells | A |
| workflows/waits-claude-input-parity.test.ts | loop | workflows/waits-parity-input-cells | A |
| workflows/waits-claude-mixed-parity.test.ts | loop | workflows/waits-parity-mixed-cells | A |
| workflows/waits-claude-process-parity.test.ts | loop | workflows/waits-parity-process-cells | A |
| workflows/waits-claude-recovery-parity.test.ts | loop | workflows/waits-parity-recovery-cells | A |
| workflows/waits-claude-refusal-parity.test.ts | loop | workflows/waits-parity-refusal-cells | A |
| workflows/waits-claude-registration-parity.test.ts | loop | workflows/waits-parity-registration-cells | A |
| workflows/waits-claude-subagents-parity.test.ts | loop | workflows/waits-subagents-parity-cells | A |
| workflows/waits-codex-every-runner-base-delivery-parity.test.ts | loop | workflows/waits-parity-base-delivery-fold | A |
| workflows/waits-codex-every-runner-base-parity.test.ts | loop | workflows/waits-parity-base-fold | A |
| workflows/waits-codex-every-runner-base-registration-parity.test.ts | loop | workflows/waits-parity-base-registration-fold | A |
| workflows/waits-codex-every-runner-entries-nudges-parity.test.ts | loop | workflows/waits-parity-entries-nudges-fold | A |
| workflows/waits-codex-every-runner-entries-refusals-parity.test.ts | loop | workflows/waits-parity-entries-refusals-fold | A |
| workflows/waits-codex-every-runner-workers-closed-parity.test.ts | loop | workflows/waits-parity-workers-closed-fold | A |
| workflows/waits-codex-every-runner-workers-parity.test.ts | loop | workflows/waits-parity-workers-fold | A |
| workflows/waits-codex-every-runner-workers-refusals-parity.test.ts | loop | workflows/waits-parity-workers-refusals-fold | A |
| workflows/waits-codex-subagents-parity.test.ts | loop | workflows/waits-subagents-parity-cells | A |
| workflows/waits-omp-every-runner-base-delivery-parity.test.ts | loop | workflows/waits-parity-base-delivery-fold | A |
| workflows/waits-omp-every-runner-base-parity.test.ts | loop | workflows/waits-parity-base-fold | A |
| workflows/waits-omp-every-runner-base-registration-parity.test.ts | loop | workflows/waits-parity-base-registration-fold | A |
| workflows/waits-omp-every-runner-entries-nudges-parity.test.ts | loop | workflows/waits-parity-entries-nudges-fold | A |
| workflows/waits-omp-every-runner-entries-refusals-parity.test.ts | loop | workflows/waits-parity-entries-refusals-fold | A |
| workflows/waits-omp-every-runner-workers-closed-parity.test.ts | loop | workflows/waits-parity-workers-closed-fold | A |
| workflows/waits-omp-every-runner-workers-parity.test.ts | loop | workflows/waits-parity-workers-fold | A |
| workflows/waits-omp-every-runner-workers-refusals-parity.test.ts | loop | workflows/waits-parity-workers-refusals-fold | A |
| workflows/waits-omp-subagents-parity.test.ts | loop | workflows/waits-subagents-parity-cells | C |
| workflows/waits-opencode-every-runner-base-delivery-parity.test.ts | loop | workflows/waits-parity-base-delivery-fold | A |
| workflows/waits-opencode-every-runner-base-parity.test.ts | loop | workflows/waits-parity-base-fold | A |
| workflows/waits-opencode-every-runner-base-registration-parity.test.ts | loop | workflows/waits-parity-base-registration-fold | A |
| workflows/waits-opencode-every-runner-entries-nudges-parity.test.ts | loop | workflows/waits-parity-entries-nudges-fold | A |
| workflows/waits-opencode-every-runner-entries-refusals-parity.test.ts | loop | workflows/waits-parity-entries-refusals-fold | A |
| workflows/waits-opencode-every-runner-workers-closed-parity.test.ts | loop | workflows/waits-parity-workers-closed-fold | A |
| workflows/waits-opencode-every-runner-workers-parity.test.ts | loop | workflows/waits-parity-workers-fold | A |
| workflows/waits-opencode-every-runner-workers-refusals-parity.test.ts | loop | workflows/waits-parity-workers-refusals-fold | A |
| workflows/waits-opencode-subagents-parity.test.ts | loop | workflows/waits-subagents-parity-cells | C |
| workflows/waits-parity.test.ts | loop | workflows/waits-parity-cells | A |
| workflows/waits-pi-every-runner-base-delivery-parity.test.ts | loop | workflows/waits-parity-base-delivery-fold | A |
| workflows/waits-pi-every-runner-base-parity.test.ts | loop | workflows/waits-parity-base-fold | A |
| workflows/waits-pi-every-runner-base-registration-parity.test.ts | loop | workflows/waits-parity-base-registration-fold | A |
| workflows/waits-pi-every-runner-entries-nudges-parity.test.ts | loop | workflows/waits-parity-entries-nudges-fold | A |
| workflows/waits-pi-every-runner-entries-refusals-parity.test.ts | loop | workflows/waits-parity-entries-refusals-fold | A |
| workflows/waits-pi-every-runner-workers-closed-parity.test.ts | loop | workflows/waits-parity-workers-closed-fold | A |
| workflows/waits-pi-every-runner-workers-parity.test.ts | loop | workflows/waits-parity-workers-fold | A |
| workflows/waits-pi-every-runner-workers-refusals-parity.test.ts | loop | workflows/waits-parity-workers-refusals-fold | A |
| workflows/waits-pi-subagents-parity.test.ts | loop | workflows/waits-subagents-parity-cells | C |
| workflows/waits-wake-budget.test.ts | edit | workflows/worker-wait | A |
| workflows/waits-wake-questions.test.ts | edit | workflows/worker-wait | A |
| workflows/waits.testkit.test.ts | edit | workflows/fixture-no-runner | B-helper |
| workflows/worker-closed-recovery.test.ts | loop | workflows/worker-wait-claude | B-fake |
| workflows/worker-inbox-liveness.test.ts | loop | workflows/worker-wait | A |
| workflows/worker-location-evidence.test.ts | loop | workflows/worker-wait | A |
| workflows/worker-parent-attention-capacity-wake.test.ts | loop | workflows/worker-parent-attention | A |
| workflows/worker-parent-attention-continued-delayed-progress.test.ts | loop | workflows/worker-parent-attention | A |
| workflows/worker-parent-attention-continued-ordinary-progress.test.ts | loop | workflows/worker-parent-attention | A |
| workflows/worker-parent-attention-continued-spawn-ask.test.ts | loop | workflows/worker-parent-attention | A |
| workflows/worker-parent-attention-fresh-delayed-progress.test.ts | loop | workflows/worker-parent-attention | A |
| workflows/worker-parent-attention-fresh-ordinary-progress.test.ts | loop | workflows/worker-parent-attention | A |
| workflows/worker-parent-attention-fresh-spawn-ask.test.ts | loop | workflows/worker-parent-attention | A |
| workflows/worker-parent-attention-restart-human-ask.test.ts | loop | workflows/worker-parent-attention | A |
| workflows/worker-parent-attention.test.ts | loop | workflows/worker-parent-attention | B-tables |
| workflows/worker-park-notice.test.ts | loop | workflows/worker-wait | A |
| workflows/worker-question-guidance.test.ts | loop | delegation/service | #3937 |
| workflows/worker-questions-fallback-checkpoints.test.ts | loop | workflows/worker-wait-claude | A |
| workflows/worker-questions-inbox-capacity.test.ts | loop | workflows/worker-wait-claude | A |
| workflows/worker-questions-parent-only.test.ts | loop | workflows/worker-wait-claude | A |
| workflows/worker-questions-parent-unreadable.test.ts | loop | workflows/worker-wait-claude | A |
| workflows/worker-questions-replies.test.ts | loop | workflows/worker-wait-claude | A |
| workflows/worker-questions-reply-recovery.test.ts | loop | workflows/worker-wait-claude | A |
| workflows/worker-questions-reply-restart.test.ts | loop | workflows/worker-questions | A |
| workflows/worker-questions-reply-settlement.test.ts | loop | workflows/worker-wait-claude | A |
| workflows/worker-questions-routing-recovery.test.ts | loop | workflows/worker-wait-claude | A |
| workflows/worker-questions-routing.test.ts | loop | workflows/worker-wait-claude | A |
| workflows/worker-reboot-collect-parity.test.ts | loop | workflows/worker-reboot-parity | A |
| workflows/worker-reboot-destroy-parity.test.ts | loop | workflows/worker-reboot-parity | A |
| workflows/worker-reboot-parity.test.ts | loop | workflows/worker-reboot-parity | B-tables |
| workflows/worker-reboot-reuse-parity.test.ts | loop | workflows/worker-reboot-parity | A |
| workflows/worker-restart-destroy-absent-ledger-parity.test.ts | loop | workflows/worker-restart-parity | A |
| workflows/worker-restart-destroy-incomplete-ledger-parity.test.ts | loop | workflows/worker-restart-parity | A |
| workflows/worker-restart-parity.test.ts | loop | workflows/worker-restart-parity | B-tables |
| workflows/worker-restart-same-boot-crash-lock-parity.test.ts | loop | workflows/worker-restart-parity | A |
| workflows/worker-restart-starting-proof-parity.test.ts | loop | workflows/worker-restart-parity | A |
| workflows/worker-stop-cancel-event.test.ts | loop | workflows/worker-wait-claude | A |
| workflows/worker-wait-cancellation.test.ts | loop | workflows/worker-wait-claude | A |
| workflows/worker-wait-capacity-ask-admission.test.ts | loop | core/workflow-parity-core | A |
| workflows/worker-wait-capacity-finish-admission.test.ts | loop | workflows/worker-wait-readiness | A |
| workflows/worker-wait-capacity-finish-cancellation.test.ts | loop | workflows/worker-wait-claude | A |
| workflows/worker-wait-capacity-finish-intent.test.ts | loop | workflows/worker-wait-claude | A |
| workflows/worker-wait-capacity-finish-retry.test.ts | loop | workflows/worker-wait | A |
| workflows/worker-wait-capacity-held-ack.test.ts | loop | workflows/worker-wait | A |
| workflows/worker-wait-capacity-held-response.test.ts | loop | workflows/worker-wait | A |
| workflows/worker-wait-capacity-restart.test.ts | loop | workflows/worker-wait-claude | A |
| workflows/worker-wait-capacity-wake-checkpoint.test.ts | loop | workflows/worker-wait | A |
| workflows/worker-wait-continuation.test.ts | loop | workflows/worker-wait-claude | A |
| workflows/worker-wait-conversations.test.ts | loop | workflows/worker-wait | C |
| workflows/worker-wait-deadlines.test.ts | loop | workflows/worker-wait-claude | A |
| workflows/worker-wait-delivery-recovery.test.ts | loop | workflows/worker-wait-claude | A |
| workflows/worker-wait-disposal.test.ts | loop | workflows/fixture-cleanup | A |
| workflows/worker-wait-durability.test.ts | loop | workflows/worker-wait-claude | A |
| workflows/worker-wait-fixture-cleanup.test.ts | loop | workflows/worker-wait-core | A |
| workflows/worker-wait-fixture.test.ts | loop | workflows/worker-wait-claude | B-fake |
| workflows/worker-wait-inbox-boundaries.test.ts | loop | workflows/worker-wait-claude | A |
| workflows/worker-wait-outcomes.test.ts | loop | workflows/worker-wait-claude | A |
| workflows/worker-wait-progress-inbox.test.ts | loop | workflows/worker-wait-claude | A |
| workflows/worker-wait-request-batch.test.ts | loop | workflows/worker-wait | A |
| workflows/worker-wait-request-lifecycle.test.ts | loop | workflows/worker-wait-claude | A |
| workflows/worker-wait-resumed-requests.test.ts | loop | workflows/worker-wait | A |
| workflows/worker-wait-settlement.test.ts | loop | workflows/worker-wait-claude | A |
| workflows/worker-wait-terminal-ordering.test.ts | loop | workflows/worker-wait | A |
| workflows/worker-wait-turn-precedence.test.ts | loop | workflows/worker-wait-claude | A |
| workflows/worker-waits-human-input.test.ts | loop | workflows/worker-wait-claude | A |
| workflows/worker-waits.test.ts | loop | workflows/worker-wait-claude | A |
| workflows/workspace-semaphore.test.ts | edit | workflows/fixture-claude | A |
| workflows/worktree-setup-run.test.ts | edit | core/workflow-parity-core | A |
