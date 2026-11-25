import type { OwnerPolicy } from './owner-rule.ts';

/** Original owner rule scopes and messages (hearsay-tools/squawk#3774). */
export const OWNER_POLICIES: Record<string, OwnerPolicy> = {
  "agent-session-send-outside-handoff": {
    "name": "agent-session-send-outside-handoff",
    "message": "Hand input to a live agent session only through handToTransport in packages/cezar/src/workflows/run/input-delivery.ts. It records the session's delivery attempt, which a clean close reads before it counts a failed wake delivery (hearsay-tools/squawk#1289, ADR 0064).",
    "files": [
      "packages/cezar/src/**/*.ts"
    ],
    "ignores": [
      "packages/cezar/src/**/*.test.ts",
      "packages/cezar/src/**/*.testkit.ts",
      "packages/cezar/src/core/**",
      "packages/cezar/src/runners/*/**"
    ]
  },
  "ask-requested-read-outside-projection": {
    "name": "ask-requested-read-outside-projection",
    "message": "Read an `ask.requested` event through the pending-ask projection, packages/contract/src/pending-ask.ts (hearsay-tools/cezarion#1808): `pendingAskOf(events)` for the ask a run waits on, `askOf(event)` for one stored event, `askPayloadOf(event)` for a live runner event. It reads the payload once, so a field the ask gains reaches the card, the worker request, `cez task status` and the task webhook together.",
    "files": [
      "packages/*/src/**/*.ts",
      "packages/*/src/**/*.tsx"
    ],
    "ignores": [
      "packages/contract/src/ask.ts",
      "packages/contract/src/pending-ask.ts",
      "packages/**/*.test.ts",
      "packages/**/*.test.tsx",
      "packages/**/*.testkit.ts"
    ]
  },
  "detached-spawn-outside-helper": {
    "name": "detached-spawn-outside-helper",
    "message": "Start a process that outlives its caller through packages/cezar/src/detached-process.ts (hearsay-tools/cezarion#1815): startOwnedGroup or spawnDetached for one Squawk stops later, with stopGroup ending its whole group, or startAndForget for one Squawk never stops.",
    "files": [
      "packages/cezar/src/**/*.ts"
    ],
    "ignores": [
      "packages/cezar/src/detached-process.ts",
      "packages/cezar/src/**/*.test.ts",
      "packages/cezar/src/**/*.testkit.ts"
    ]
  },
  "e2e-raw-run-seed": {
    "name": "e2e-raw-run-seed",
    "message": "Seed browser runs with seedRuns from ./seed-runs, not a raw runs.json write. Typed fixture fields must fail typecheck when RunRecord changes (hearsay-tools/cezarion#2512).",
    "files": [
      "packages/web/e2e/**/*.e2e.ts"
    ],
    "ignores": []
  },
  "git-spawn-outside-helper": {
    "name": "git-spawn-outside-helper",
    "message": "Start git through packages/cezar/src/git-command.ts (hearsay-tools/squawk#3207): git, runGit, gitSync or spawnGit. They drop the inherited GIT_DIR, GIT_WORK_TREE and GIT_INDEX_FILE family, so git acts on cwd and not on the repository a hook or `rebase --exec` step named.",
    "files": [
      "packages/cezar/src/**/*.ts"
    ],
    "ignores": [
      "packages/cezar/src/git-command.ts",
      "packages/cezar/src/**/*.test.ts",
      "packages/cezar/src/**/*.testkit.ts"
    ]
  },
  "handoff-write-outside-writers": {
    "name": "handoff-write-outside-writers",
    "message": "The handoff file is the agent's (hearsay-tools/cezarion#1809). In handoff.ts only seedHandoffFile writes it (the skeleton, once), writeHandoffRecords rewrites Squawk's records block whole from RunRecord.handoffRecords, and deleteHandoff removes it. Record an autosave through recordHandoffAutosave or recordHandoffPeriodicAutosave; write no other line into the file.",
    "files": [
      "packages/cezar/src/handoff.ts"
    ],
    "ignores": []
  },
  "handoff-written-outside-handoff-module": {
    "name": "handoff-written-outside-handoff-module",
    "message": "Write the handoff file only through packages/cezar/src/handoff.ts (hearsay-tools/cezarion#1809): the file is the agent's, and Squawk's own records live in RunRecord.handoffRecords. Record an autosave through recordHandoffAutosave or recordHandoffPeriodicAutosave, render the block for a reader through renderHandoffRecords, and write no line into the file from here.",
    "files": [
      "packages/cezar/src/**/*.ts"
    ],
    "ignores": [
      "packages/cezar/src/handoff.ts",
      "packages/cezar/src/**/*.test.ts",
      "packages/cezar/src/**/*.testkit.ts"
    ]
  },
  "json-valid-outside-guard": {
    "name": "json-valid-outside-guard",
    "message": "Guard SQL that reads stored JSON through `guardedJsonSql(sql, onBad, columns)`, packages/cezar/src/runs/guarded-json-sql.ts (hearsay-tools/squawk#3530). It writes the `json_valid` check once, so a row whose summary or data is not JSON answers `onBad` instead of failing the whole query.",
    "files": [
      "packages/*/src/**/*.ts"
    ],
    "ignores": [
      "packages/cezar/src/runs/guarded-json-sql.ts",
      "packages/**/*.test.ts",
      "packages/**/*.testkit.ts"
    ]
  },
  "liveness-timer-outside-owner": {
    "name": "liveness-timer-outside-owner",
    "message": "Arm a run's liveness bound through LivenessTimers in packages/cezar/src/workflows/run/liveness-timers.ts (hearsay-tools/squawk#3662, ADR 0064): give the bound a row in LIVENESS_BOUNDS with its scope, call arm from a thin arm* method, and clear it with clear, clearScope or cancelLivenessTimer. A wait deadline goes to the wait engine (ADR 0061).",
    "files": [
      "packages/cezar/src/workflows/run/**/*.ts",
      "packages/cezar/src/workflows/run.ts"
    ],
    "ignores": [
      "packages/cezar/src/workflows/run/**/*.test.ts",
      "packages/cezar/src/workflows/run/**/*.testkit.ts",
      "packages/cezar/src/workflows/run/liveness-timers.ts", // The owner of every liveness bound.
      "packages/cezar/src/workflows/run/wait-engine.ts", // Wait deadlines and checkpoint retries stay in the wait engine (ADR 0061).
      "packages/cezar/src/workflows/run/wait-watches.ts", // The wait engine's deadline watch adapter (ADR 0061).
      "packages/cezar/src/workflows/run/worker-orphans.ts", // The orphan reprobe and its awaited pauses belong to a worker generation's cleanup.
      "packages/cezar/src/workflows/run/worktree-autosave.ts" // The autosave interval saves worktree evidence; it bounds no liveness.
    ]
  },
  "nudge-fact-write-outside-owner": {
    "name": "nudge-fact-write-outside-owner",
    "message": "The nudge fact has one writer (ADR 0064, .ai/specs/2026-11-15-run-lifecycle-facts.md, hearsay-tools/squawk#2452): workflows/run/turn-nudges.ts records it when it sends or tries a nudge and retires it. Call `retireNudge(state)` from turn-nudges.ts instead of sending a `nudge-fact` boundary event.",
    "files": [
      "packages/cezar/src/**/*.ts"
    ],
    "ignores": [
      "packages/cezar/src/**/*.test.ts",
      "packages/cezar/src/**/*.testkit.ts",
      "packages/cezar/src/workflows/run/turn-nudges.ts"
    ]
  },
  "outcome-write-outside-commit-outcome": {
    "name": "outcome-write-outside-commit-outcome",
    "message": "Write an outcome (a receipt, a settled wait, a charge, a failure count) through RunStore.commitOutcome, with what it depends on, in one commit (hearsay-tools/cezarion#1805): stage it as a RunOutcome in runs/outcome-commit.ts. A conversation request outcome goes through RunStore.commitConversation, which commits it with the recipient's reply input.",
    "files": [
      "packages/cezar/src/**/*.ts"
    ],
    "ignores": [
      "packages/cezar/src/**/*.test.ts",
      "packages/cezar/src/**/*.testkit.ts",
      "packages/cezar/src/runs/outcome-commit.ts"
    ]
  },
  "run-fact-write-outside-owner": {
    "name": "run-fact-write-outside-owner",
    "message": "A run lifecycle fact has one owner that records it when the thing happens (ADR 0064, .ai/specs/2026-11-15-run-lifecycle-facts.md). `workflowCursor` and `parkReason` are written only by the exits' fields() in runs/run-exits.ts: for the cursor, name the step and the mode in the ExitCall (`{ stepId, cursor: 'start' | 'resume' }`) of the exit you move the run with. `continuesStepId` is written only by workflows/continuation-admission.ts, once, on the synthetic step a Continue admits. `doneAccepted` is recorded only by `recordDoneAccepted` in workflows/run/run-finish.ts; `retireDoneAccepted` and `spendDoneFreeTurn` in workflows/run/turn-settler.ts retire it and spend its free turn, all through RunStore.commitOutcome (`done-accepted`, `done-retired`, `done-free-turn`). (hearsay-tools/squawk#3774).",
    "files": [
      "packages/cezar/src/**/*.ts",
      "packages/contract/src/**/*.ts"
    ],
    "ignores": [
      "packages/cezar/src/**/*.test.ts",
      "packages/cezar/src/**/*.testkit.ts",
      "packages/contract/src/**/*.test.ts",
      "packages/contract/src/**/*.testkit.ts",
      "packages/cezar/src/runs/run-exits.ts",
      "packages/cezar/src/workflows/continuation-admission.ts"
    ]
  },
  "run-internals": {
    "name": "run-internals",
    "message": "runInternals and its testkit are retired: use public methods, fixture-owned dependencies and durable records (hearsay-tools/cezarion#2522). Making RunManager's private members ES #private, so that no other private access compiles or reads state, is tracked in hearsay-tools/cezarion#2700.",
    "files": [
      "**/*.ts"
    ],
    "ignores": []
  },
  "run-memory-field-outside-owner": {
    "name": "run-memory-field-outside-owner",
    "message": "Keep per-run memory in RunMemory (workflows/run/run-memory.ts): add a field to RunSlot and read and write it through RunMemory, which releases it when the run ends, is deleted or the manager is disposed (ADR 0064, hearsay-tools/squawk#2064). A map that must stay on its module needs an entry in this rule's ignores with its reason.",
    "files": [
      "packages/cezar/src/workflows/run.ts",
      "packages/cezar/src/workflows/run/**/*.ts"
    ],
    "ignores": [
      "packages/cezar/src/workflows/run/**/*.test.ts",
      "packages/cezar/src/workflows/run/**/*.testkit.ts",
      "packages/cezar/src/workflows/run/run-memory.ts", // The owner.
      "packages/cezar/src/workflows/run.ts", // #active: the active-run registry; only activate and dropActive write it (ADR 0053).
      "packages/cezar/src/workflows/run/continuation-acceptance.ts", // successSuperseded compares the continuation token after its I/O, also after dispose.
      "packages/cezar/src/workflows/run/family-reconciler.ts", // Family roots queued for one reconcile pass.
      "packages/cezar/src/workflows/run/liveness-timers.ts", // The owner of every liveness bound, keyed by kind, run and key; RunMemory's release clears a run's run scope (hearsay-tools/squawk#3662).
      "packages/cezar/src/workflows/run/live-session-state.ts", // A session group on the ActiveRun: it goes with the ActiveRun at dropActive.
      "packages/cezar/src/workflows/run/maintenance-claims.ts", // reclaiming: cleanup evidence that outlives an execution.
      "packages/cezar/src/workflows/run/run-line.ts", // The scheduler indexes: busySlots and pump order and count them; dropActive calls line.forget.
      "packages/cezar/src/workflows/run/squawk-tools.ts", // Tool calls that wait for the automation service, not per-run memory.
      "packages/cezar/src/workflows/run/subagent-waits.ts", // A session group on the ActiveRun: it goes with the ActiveRun at dropActive.
      "packages/cezar/src/workflows/run/tracked-work.ts", // Process work keyed by promise and session, not by run.
      "packages/cezar/src/workflows/run/usage-accounting.ts", // The turn ids of one runner invocation, held by its step.
      "packages/cezar/src/workflows/run/wait-engine.ts", // Keyed by wait id (ADR 0061).
      "packages/cezar/src/workflows/run/wait-registry.ts", // Keyed by wait id (ADR 0061).
      "packages/cezar/src/workflows/run/worker-executions.ts", // One worker generation's execution, and proveRunTermination waiters.
      "packages/cezar/src/workflows/run/worker-orphans.ts", // The orphan maps: each entry lives for one worker generation.
      "packages/cezar/src/workflows/run/worktree-autosave.ts" // autosaveTasks: cleanup evidence that outlives an execution.
    ]
  },
  "run-search-field-list-outside-contract": {
    "name": "run-search-field-list-outside-contract",
    "message": "Search runs with matchesRunSearch from packages/contract/src/run-search.ts, and add a searchable field to RUN_SEARCH_FIELDS there (hearsay-tools/cezarion#1807). A list that holds a run's branch and its workflow is a second search matcher: the project list, All tasks, the archived pages, the ⌘K palette and the SQL prefilter each grew their own, and every new field needed a follow-up fix in each (hearsay-tools/cezarion#1637).",
    "files": [
      "packages/cezar/src/**/*.ts",
      "packages/web/src/**/*.ts",
      "packages/web/src/**/*.tsx"
    ],
    "ignores": [
      "**/*.test.ts",
      "**/*.test.tsx",
      "**/*.testkit.ts"
    ]
  },
  "runner-class-outside-factory": {
    "name": "runner-class-outside-factory",
    "message": "Only a runner's own folder, packages/cezar/src/runners/<id>/, constructs a runner class or loads a concrete runner module, through the definition's loadAdapter (hearsay-tools/cezarion#2939). Other code takes a RunnerFactory (core/agent-runner.ts) such as createRunner in core/runner-registry.ts; use `import type` for a type.",
    "files": [
      "packages/cezar/src/**/*.ts"
    ],
    "ignores": [
      "packages/cezar/src/runners/*/**",
      "packages/cezar/src/**/*.test.ts",
      "packages/cezar/src/**/*.testkit.ts"
    ]
  },
  "server-declared-validator-schema": {
    "name": "server-declared-validator-schema",
    "message": "Declare the request schema in packages/contract and import its value from @open-mercato/cezar-contract/<module> (docs/areas/http-api.md); server.ts only chains routes. (hearsay-tools/squawk#3774).",
    "files": [
      "packages/cezar/src/server/server.ts",
      "packages/cezar/src/server/*-routes.ts"
    ],
    "ignores": []
  },
  "skills-read-outside-enabled-skills": {
    "name": "skills-read-outside-enabled-skills",
    "message": "Read a run's skills through RunSkills.enabledSkills(state) (workflows/run/run-skills.ts), which reads the session's runner skill list (hearsay-tools/squawk#3752). Only RunSkills.loadRunSkills writes `state.skills.catalog` (skills-write-outside-load-run-skills).",
    "files": [
      "packages/cezar/src/workflows/run.ts",
      "packages/cezar/src/workflows/run/**"
    ],
    "ignores": ["packages/cezar/src/workflows/run/launch-read-resolver.ts"]
  },
  "skills-write-outside-load-run-skills": {
    "name": "skills-write-outside-load-run-skills",
    "message": "Write the session's runner skill list only in RunSkills.loadRunSkills (workflows/run/run-skills.ts), called at step open and Continue. Read it through RunSkills.enabledSkills (hearsay-tools/squawk#3752).",
    "files": [
      "packages/cezar/src/workflows/run.ts",
      "packages/cezar/src/workflows/run/**"
    ],
    "ignores": []
  },
  "wait-kind-literal-outside-engine": {
    "name": "wait-kind-literal-outside-engine",
    "message": "Branch on a wait's kind only in the wait engine, the wait-kind table, the watch adapters, the read-time upgrade and the boundary views (ADR 0061, hearsay-tools/cezarion#3079). Elsewhere read the row (waitPolicyForWait(wait).<fact>), select one kind's waits with its row's selector (WAIT_KINDS.<kind>.select, .selectOpen, .is), or ask the engine.",
    "files": [
      "packages/cezar/src/**/*.ts"
    ],
    "ignores": [
      "packages/cezar/src/**/*.test.ts",
      "packages/cezar/src/**/*.testkit.ts",
      "packages/cezar/src/activity/wait.ts",
      "packages/cezar/src/ci-wait/pr-wait-kind.ts",
      "packages/cezar/src/delegation/service.ts",
      "packages/cezar/src/delegation/wait-kinds.ts",
      "packages/cezar/src/runs/legacy-waits.ts",
      "packages/cezar/src/runs/wait-helpers.ts",
      "packages/cezar/src/server/forge/github*.ts",
      "packages/cezar/src/workflows/run/wait-kinds.ts"
    ]
  },
  "worktree-write-outside-manifest": {
    "name": "worktree-write-outside-manifest",
    "message": "Write into a task worktree through withWorktreeFiles (packages/cezar/src/worktree-manifest.ts), which records each path Squawk wrote and never replaces or removes one the agent changed (hearsay-tools/cezarion#1814). A module that writes there imports no file-changing node:fs function.",
    "files": [
      "packages/cezar/src/worktree-skill-cleanup.ts",
      "packages/cezar/src/agent-config/seed.ts"
    ],
    "ignores": []
  }
};
