/* oxlint-disable cez/run-internals -- The retired name and module path are rule fixtures. */
import { AST_RULES } from './plugin.ts';
import { ruleCases } from './ast-rule.testkit.ts';

// Every former ast-grep case, with its original source and diagnostic count (hearsay-tools/squawk#3774).

ruleCases(AST_RULES.find(rule => rule.name === "outcome-write-outside-commit-outcome")!, {
  "file": "packages/cezar/src/fixture.ts",
  "valid": [
    "this.store.commitOutcome(runId, { kind: 'charged', automaticWakes: 3 }, {}, { bestEffort: true })",
    "const outcomes = [{ kind: 'counted' as const, waitDeliveryFailures: undefined }]",
    "const schema = z.object({ deliveredAt: z.string().optional() })",
    "const row = base.extend({ automaticWakes: contractRunRecordSchema.shape.automaticWakes.catch(undefined) })",
    "const at = input.deliveredAt",
    "if (run.automaticWakes) charge()",
    "const done = wait.phase === 'delivered'",
    "const { deliveredAt: _delivered, ...queued } = input",
    "const { lastWaits } = run",
    "interface Receipt { consumedAt?: string; phase: \"delivered\" }",
    "const open = { ...wait, phase: 'open' }",
    "export function upgradeLegacyWaits(row) { row.lastWaits = [] }",
    "export function ciWaitEntry(wait) { return { phase: 'delivered', ...(deliveredAt ? { deliveredAt } : {}) } }",
    "function settleLegacyAgentWait(entry, deliveredAt) { Object.assign(entry, { phase: 'delivered', deliveredAt }) }"
  ],
  "invalid": [
    "this.store.updateRun(id, { automaticWakes: 0 })",
    "const input = { ...queued, deliveredAt: now }",
    "const next = { ...run, lastWaits }",
    "run.waitDeliveryFailures = 2",
    {
      "code": "return { ...wait, phase: 'cancelled', cancelledAt }",
      "errors": 2
    },
    "entry.consumedAt = at",
    "const settled = { phase: \"delivered\" }",
    "const outcome = { kind: 'answered', automaticWakes: 1 }"
  ]
});

ruleCases(AST_RULES.find(rule => rule.name === "run-fact-write-outside-owner")!, {
  "file": "packages/cezar/src/fixture.ts",
  "valid": [
    "this.host.move(runId, 'requeue', {}, { stepId: next.id, cursor: 'start' })",
    "const row = z.object({ workflowCursor: workflowCursorSchema.optional() })",
    "const salvaged = { workflowCursor: contractRunRecordSchema.shape.workflowCursor.catch(undefined) }",
    "const row = z.object({ parkReason: z.enum(['turn', 'hold', 'closing-wakes']).optional() })",
    "const reason = run.parkReason",
    "const row = z.object({ continuesStepId: z.string().optional() })",
    "const extended = owningStep.continuesStepId ?? owningStep.id",
    "const resumed = run.workflowCursor?.mode === 'resume' ? run.workflowCursor.stepId : undefined",
    "if (run.workflowCursor) start(run.workflowCursor.stepId)",
    "const { workflowCursor } = run",
    "const { workflowCursor: _cursor, ...rest } = run",
    "type Read = { workflowCursor?: WorkflowCursor }",
    "interface Row { workflowCursor?: { stepId: string } }",
    "export function recordDoneAccepted(store, runId, done) { store.commitOutcome(runId, { kind: 'done-accepted', ...done }) }",
    "export function retireDoneAccepted(store, runId, as, reason) { store.commitOutcome(runId, { kind: 'done-retired', as, reason }) }",
    "const APPLY = { 'done-accepted'(run, outcome) { return { run: { ...run, doneAccepted: { session: outcome.session, at: outcome.at } }, changed: true } } }",
    "const APPLY = { 'done-retired'(run) { const { doneAccepted: _done, ...rest } = run; return { run: rest, changed: true } } }",
    "type RunOutcome = { kind: 'done-accepted'; session: string } | { kind: 'done-retired'; as: 'completed' }",
    "export function spendDoneFreeTurn(store, runId) { store.commitOutcome(runId, { kind: 'done-free-turn' }) }",
    "const done = run.doneAccepted",
    "const row = z.object({ doneAccepted: doneAcceptedSchema.optional() })",
    "export function upgradeLegacyDoneAccepted(row) { row.doneAccepted = { ...done, openWaits: [], settledWaits: [] } }",
    "export function upgradeLegacyWorkflowCursor(row) { row.workflowCursor = { stepId, mode: 'resume' } }"
  ],
  "invalid": [
    "this.context.store.updateRun(runId, { workflowCursor: { stepId, mode: 'start' } })",
    "this.context.store.updateRun(runId, { workflowCursor: undefined })",
    "this.host.move(runId, 'requeue', { workflowCursor: { stepId: next.id, mode: 'start' } })",
    "const next = { ...run, workflowCursor }",
    "run.workflowCursor = undefined",
    "record.workflowCursor = { stepId: 'review', mode: 'resume' }",
    "this.context.store.updateRun(runId, { parkReason: 'turn' })",
    "const parked = { ...run, parkReason }",
    "this.context.store.updateStep(runId, 'continue-1', { continuesStepId: 'review' })",
    "store.addStep(runId, { id: 'continue-2', name: 'Continue', kind: 'agent', synthetic: 'continuation', continuesStepId })",
    "step.continuesStepId = 'implement'",
    "this.context.store.updateRun(runId, { doneAccepted: { session, at } })",
    "this.context.store.commitOutcome(runId, [], { patch: { doneAccepted: undefined } })",
    "this.context.store.commitOutcome(runId, { kind: 'done-accepted', session, at })",
    "store.commitOutcome(runId, { kind: 'done-retired', as: 'reconsidered', reason: 'human message' })",
    "run.doneAccepted = undefined",
    "this.context.store.commitOutcome(runId, { kind: 'done-free-turn' })"
  ]
});

ruleCases(AST_RULES.find(rule => rule.name === "run-memory-field-outside-owner")!, {
  "file": "packages/cezar/src/workflows/run/fixture.ts",
  "valid": [
    "class Part { readonly memory = new RunMemory(); }",
    "class Part { readonly queue: string[] = []; }",
    "class Part { readonly names = new WeakSet(); }",
    "class Part { readonly bound = new globalThis.Map(); }",
    "class Part { constructor() { this.byRun = new Map(); } }",
    "class Part { read(id) { const local = new Map(); return local.get(id); } }",
    "const byRun = new Map();"
  ],
  "invalid": [
    "class Part { readonly byRun = new Map<string, number>(); }",
    "class Part { private readonly byRun = new Set<string>(); }",
    "class Part { #byRun = new Map(); }",
    "class Part { static byRun = new WeakMap(); }",
    "class Part { byRun = new Map([[\"a\", 1]]); }"
  ]
});

ruleCases(AST_RULES.find(rule => rule.name === "skills-read-outside-enabled-skills")!, {
  "file": "packages/cezar/src/workflows/run.ts",
  "valid": [
    "state.skills.catalog = []",
    "this.active.get(runId).skills.catalog = skills",
    "class A { private enabledSkills(state: ActiveRun) { return filter(state.skills.catalog ?? []) } }",
    "this.active.get(runId)!.skills.catalog = skills",
    "const skills = await this.discoverSkills()",
    "launch.skills.catalog.files",
    "const { catalog } = launch.skills",
    "const x = this.pending.get(runId)?.skills.catalog",
    "const x = this.active.get(runId)?.session"
  ],
  "invalid": [
    "const x = this.active.get(runId)?.skills.catalog",
    "const x = this.active.get(runId)!.skills.catalog ?? []",
    "const x = this.active.get(runId).skills.catalog",
    "const x = this.active.get(runId)?.['skills']['catalog']",
    "const { catalog } = this.active.get(runId).skills",
    "const x = state.skills.catalog",
    "const x = state?.skills.catalog ?? []",
    "state.skills.catalog = state.skills.catalog ?? []",
    "const x = active.skills.catalog",
    "const x = execution.state.skills.catalog",
    "const x = state['skills']['catalog']",
    "const { catalog } = state.skills",
    "class A { other(state: ActiveRun) { return state.skills.catalog } }"
  ]
});

ruleCases(AST_RULES.find(rule => rule.name === "skills-write-outside-load-run-skills")!, {
  "file": "packages/cezar/src/workflows/run.ts",
  "valid": [
    "class A { async loadRunSkills(state: ActiveRun) { skillsWrites.catalog(state.skills, await discovery); } }",
    "class A { private async loadRunSkills(state: ActiveRun) { state.skills.catalog = await this.discoverSkills() } }",
    "const x = state.skills.catalog",
    "launch.skills.catalog = []",
    "const skills = await this.discoverSkills()",
    "this.pending.get(runId).skills.catalog = skills",
    "state.session = undefined"
  ],
  "invalid": [
    "state.skills.catalog = []",
    "state.skills.catalog = skills",
    "state.skills.catalog ??= []",
    "state.skills.catalog += more",
    "state['skills']['catalog'] = []",
    "active.skills.catalog = skills",
    "execution.state.skills.catalog = skills",
    "this.active.get(runId).skills.catalog = skills",
    "this.active.get(runId)!.skills.catalog = skills",
    "class A { other(state: ActiveRun) { state.skills.catalog = [] } }",
    "class A { async runContinuation(state: ActiveRun) { state.skills.catalog = await this.discoverSkills() } }",
    "class A { async other(state: ActiveRun) { skillsWrites.catalog(state.skills, await discovery); } }"
  ]
});

ruleCases(AST_RULES.find(rule => rule.name === "worktree-write-outside-manifest")!, {
  "file": "packages/cezar/src/skills-provision.ts",
  "valid": [
    "import { readFile, lstat } from 'node:fs/promises'",
    "import { existsSync, readFileSync } from 'node:fs'",
    "import type { Stats } from 'node:fs'",
    "import { writeFile } from './worktree-manifest.ts'",
    "import { join } from 'node:path'",
    "const path = await import('node:path')"
  ],
  "invalid": [
    "import { writeFile } from 'node:fs/promises'",
    "import { readFile, rm } from 'fs/promises'",
    "import { mkdirSync } from 'node:fs'",
    "import { promises } from 'node:fs'",
    "import { rename as move } from \"node:fs/promises\"",
    "import * as fs from 'node:fs'",
    "import fs from 'fs'",
    "const fs = await import('node:fs/promises')"
  ]
});

ruleCases(AST_RULES.find(rule => rule.name === "skills-read-outside-enabled-skills")!, {
  "file": "packages/cezar/src/workflows/run/fixture.ts",
  "valid": [
    "const {catalog: local} = state.skills",
    "const {other: catalog} = state.skills",
    "const {catalog = []} = state.skills",
    "const x = (state as ActiveRun).skills.catalog",
    "const skillSourceReads = { enabledSkills(state) { return state.skills.catalog } }"
  ],
  "invalid": [
    "const x = state.skills['catalog']",
    "const x = state[`skills`].catalog"
  ]
});

ruleCases(AST_RULES.find(rule => rule.name === "run-fact-write-outside-owner")!, {
  "file": "packages/cezar/src/workflows/run/fixture.ts",
  "valid": [
    "const x = {workflowCursor: factory(aSchema)}",
    "const x = {workflowCursor: foo['mySchema']}"
  ],
  "invalid": [
    "const x = {workflowCursor: factory(z.string())}"
  ]
});

ruleCases(AST_RULES.find(rule => rule.name === "outcome-write-outside-commit-outcome")!, {
  "file": "packages/cezar/src/workflows/run/fixture.ts",
  "valid": [
    "const x = {kind: 'counted' as any,automaticWakes: 2}"
  ],
  "invalid": [
    "const x = {automaticWakes: factory(z.string())}",
    "const x = {kind: `counted`,automaticWakes: 2}"
  ]
});
