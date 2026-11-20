import { BUILT_IN_RUNNER_IDS } from '../runners/built-in.ts';
import { expect, it } from 'vitest';
/* oxlint-disable cez/run-internals -- The retired name and module path are rule fixtures. */
import { AST_RULES } from './plugin.ts';
import { ruleCases } from './ast-rule.testkit.ts';

// Every former YAML case, with its original source and diagnostic count (hearsay-tools/squawk#3774).

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

ruleCases(AST_RULES.find(rule => rule.name === "run-internals")!, {
  "file": "packages/cezar/src/legacy.ts",
  "valid": [
    "const runInternalsCount = 1;",
    "otherInternals(manager);",
    "import { helper } from \"./other.testkit.ts\"; helper(manager);",
    "const kit = await import(\"./other.testkit.ts\"); kit.helper(manager);",
    "const kit = require(\"./other.testkit.ts\");",
    "const kit = await import(\"./other.testkit.ts\", { with: { note: \"x\" } });",
    "const name = `run-${part}.ts`;",
    "// runInternals(manager) and run-internals.testkit.ts",
    "type RunInternalsView = unknown;",
    "const text = \"call runInternals later\";"
  ],
  "invalid": [
    "runInternals(manager);",
    "runInternals();",
    "(runInternals)(manager);",
    "((runInternals))(manager);",
    "runInternals!(manager);",
    "runInternals?.(manager);",
    "kit.runInternals(manager);",
    "kit?.runInternals(manager);",
    "kit.runInternals?.(manager);",
    "(kit.runInternals)(manager);",
    "const { runInternals } = kit;",
    "const inspect = { runInternals };",
    {
      "code": "import { runInternals as inspect } from \"./run-internals.testkit.ts\"; inspect(manager);",
      "errors": 2
    },
    {
      "code": "import { runInternals } from \"../workflows/run-internals.testkit.ts\";",
      "errors": 2
    },
    "import * as kit from \"./run-internals.testkit\";",
    "import \"./run-internals.testkit.ts\";",
    "import { x } from \"run-internals.testkit\";",
    "const kit = await import(\"./run-internals.testkit.ts\");",
    "const kit = await import(\"../workflows/run-internals.testkit\");",
    "const kit = await import(\"./run-internals.testkit.ts\", {});",
    "const kit = await import((\"./run-internals.testkit.ts\"));",
    "const kit = await import(`./run-internals.testkit.ts`);",
    "const kit = require(\"./run-internals.testkit.ts\");",
    "const kit = (require)(\"./run-internals.testkit.ts\");",
    "const kit = require!(\"./run-internals.testkit.ts\");",
    "const kit = await import(selectModule(\"./run-internals.testkit.ts\"));",
    "const kit = await import(`${root}/run-internals.testkit.ts`);",
    "const label = \"run-internals.testkit.ts\";",
    "type runInternals = unknown;",
    "interface Kit { runInternals(): void }",
    "kit[\"runInternals\"](manager);",
    "class Kit { #runInternals() {} }",
    "vi.spyOn(kit, \"runInternals\");",
    {
      "code": "runInternals: for (;;) { break runInternals; }",
      "errors": 2
    }
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

ruleCases(AST_RULES.find(rule => rule.name === "run-search-field-list-outside-contract")!, {
  "file": "packages/cezar/src/fixture.ts",
  "valid": [
    "const key = [run.branch, run.id]",
    "const label = [run.workflow]",
    "const a = [run.branch]; const b = [run.workflow]",
    "const row = { branch: run.branch, workflow: run.workflow }",
    "const x = [pr.title, pr.body]"
  ],
  "invalid": [
    "const fields = [runTitle(run), run.branch ?? '', run.workflow, workflowLabel(run), extraText(run)]",
    "const parts = [runTitle(task.run), task.projectName, task.run.workflow, task.run.branch ?? '', ...task.tags]",
    "const prose = [run.title, run.titleSummary, run.branch, run.workflow, run.workflowLabel, origin]",
    "const fields = [a?.branch, lower(b.workflow)]"
  ]
});

ruleCases(AST_RULES.find(rule => rule.name === "runner-class-outside-factory")!, {
  "file": "packages/cezar/src/fixture.ts",
  "valid": [
    "import { createRunner } from './core/runner-registry.ts'",
    "import type { AgentSession } from '../../runners/claude/claude-cli-runner.ts'",
    "export type { AgentSession } from '../runners/claude/claude-cli-runner.ts'",
    "import { BUILT_IN_RUNNER_IDS, type RunnerFactory } from '../core/agent-runner.ts'",
    "const kit = await import('../core/agent-runner.ts')",
    "import { ScheduleRunner } from './schedule-runner.ts'",
    "const runner = new ScheduleRunner(handle)",
    "const runner = createRunner(backend)",
    "const runner: ClaudeCliRunner = make()",
    "type Session = import('../runners/pi/pi-runner.ts').PiSession",
    "function close(session: import('../runners/omp/omp-runner.ts').OmpSession): void {}",
    "// new PiRunner()"
  ],
  "invalid": [
    "const runner = new ClaudeCliRunner()",
    "const runner = new OpencodeServerRunner()",
    "const runner = new runners.PiRunner()",
    "return backend === 'omp' ? new OmpRunner() : fallback",
    "import { CodexAppServerRunner } from '../runners/codex/codex-app-server-runner.ts'",
    "import { OpencodeServerRunner as Runner } from '../../runners/opencode/opencode-server-runner.js'",
    "import * as pi from './runners/pi/pi-runner.ts'",
    "import { type AgentSession } from '../runners/claude/claude-cli-runner.ts'",
    "import '../runners/omp/omp-runner.ts'",
    "export { PiRunner } from '../runners/pi/pi-runner.ts'",
    "export * from '../core/cursor-runner.ts'",
    "const mod = await import('../runners/pi/pi-runner.ts')",
    "const mod = require('../runners/omp/omp-runner.js')",
    "const load = async () => { const { PiRunner } = await import('../runners/pi/pi-runner.ts'); return PiRunner }",
    "const runner = made as import('../runners/pi/pi-runner.ts').PiRunner"
  ]
});

ruleCases(AST_RULES.find(rule => rule.name === "server-declared-validator-schema")!, {
  "file": "packages/cezar/src/server/server.ts",
  "valid": [
    "import { startRunSchema } from '@open-mercato/cezar-contract/runs'\napp.post('/runs', jsonZodValidator(startRunSchema), handler)\n",
    "import { idSchema } from './ids.ts'\napp.get('/x', paramZodValidator(idSchema.pick({ id: true })), handler)\n",
    "const parseOutput = z.object({ ok: z.boolean() })\nparseOutput.parse(value)\n",
    "const unusedSchema = z.object({ a: z.string() })\napp.get('/x', handler)\n",
    "app.get('/x', paramZodValidator(contractSchema, z.object({ message: 'x' })), handler)\n"
  ],
  "invalid": [
    "const planSchema = z.object({ a: z.string() })\napp.post('/plan', jsonZodValidator(planSchema), handler)\n",
    "const planSchema = z.object({ a: z.string() })\napp.post('/plan', jsonZodValidator(planSchema, { message: 'bad' }), handler)\n",
    "const waitQuery = z.object({ wait: z.string() })\napp.get('/wait', queryZodValidator(waitQuery), handler)\n",
    "function build() {\n  app.post('/p', jsonZodValidator(() => registerSchema, { message: 'bad' }), handler)\n  const registerSchema = z.object({ root: z.string() })\n}\n",
    "app.get('/x', paramZodValidator(z.object({ id: z.string() })), handler)\n",
    "app.post('/x', jsonZodValidator(z.object({ id: z.string() }).strict(), { message: 'bad' }), handler)\n"
  ]
});

ruleCases(AST_RULES.find(rule => rule.name === "skills-read-outside-enabled-skills")!, {
  "file": "packages/cezar/src/workflows/run.ts",
  "valid": [
    "state.skills.catalog = []",
    "this.active.get(runId).skills.catalog = skills",
    "class A { private enabledSkills(state: ActiveRun) { return filter(state.skills.catalog ?? []) } }",
    "this.active.get(runId)!.skills.catalog = skills",
    "const skills = await this.runnerSkills()",
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
    "class A { private async loadRunSkills(state: ActiveRun) { state.skills.catalog = await this.runnerSkills() } }",
    "const x = state.skills.catalog",
    "launch.skills.catalog = []",
    "const skills = await this.runnerSkills()",
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
    "class A { async runContinuation(state: ActiveRun) { state.skills.catalog = await this.runnerSkills() } }",
    "class A { async other(state: ActiveRun) { skillsWrites.catalog(state.skills, await discovery); } }"
  ]
});

ruleCases(AST_RULES.find(rule => rule.name === "wait-kind-literal-outside-engine")!, {
  "file": "packages/cezar/src/fixture.ts",
  "valid": [
    "wait.kind === 'request'",
    "switch (kind) { case 'request': break; }",
    "const x = { kind: 'request' }",
    "wait.via === 'pr'",
    "wait.watch !== 'ci'",
    "wait.type == 'timer'",
    "WAIT_KINDS[wait.kind]",
    "type Human = Extract<Wait, { kind: 'human' }>",
    "wait.kind === targetKind",
    "const x = { kind: targetKind }",
    "switch (kind) { case targetKind: break; }"
  ],
  "invalid": [
    "wait.kind === 'pr'",
    "switch (value) { case 'pr': break; }",
    "const x = { kind: 'pr' }",
    "wait.kind === 'timer'",
    "switch (value) { case 'timer': break; }",
    "const x = { kind: 'timer' }",
    "wait.kind === 'process'",
    "switch (value) { case 'process': break; }",
    "const x = { kind: 'process' }",
    "wait.kind === 'human'",
    "switch (value) { case 'human': break; }",
    "const x = { kind: 'human' }",
    "wait.kind === 'worker'",
    "switch (value) { case 'worker': break; }",
    "const x = { kind: 'worker' }",
    "wait.kind === 'peer'",
    "switch (value) { case 'peer': break; }",
    "const x = { kind: 'peer' }",
    "wait.kind === 'subagent'",
    "switch (value) { case 'subagent': break; }",
    "const x = { kind: 'subagent' }",
    "wait.kind === 'ci'",
    "switch (value) { case 'ci': break; }",
    "const x = { kind: 'ci' }",
    "kind === 'pr'",
    "'timer' === kind",
    "'timer' === wait.kind",
    "wait?.kind === 'pr'",
    "'timer' === wait?.kind",
    "kind !== 'pr'",
    "'timer' !== kind",
    "wait.kind !== 'pr'",
    "'timer' !== wait.kind",
    "wait?.kind !== 'pr'",
    "'timer' !== wait?.kind",
    "kind == 'pr'",
    "'timer' == kind",
    "wait.kind == 'pr'",
    "'timer' == wait.kind",
    "wait?.kind == 'pr'",
    "'timer' == wait?.kind",
    "kind != 'pr'",
    "'timer' != kind",
    "wait.kind != 'pr'",
    "'timer' != wait.kind",
    "wait?.kind != 'pr'",
    "'timer' != wait?.kind",
    "wait.kind === 'worker' as const",
    "switch (value) { case 'worker' as const: break; }",
    "const x = { kind: 'worker' as const }",
    "wait.kind === 'peer' satisfies string",
    "switch (value) { case 'peer' satisfies string: break; }",
    "const x = { kind: 'peer' satisfies string }"
  ]
});

ruleCases(AST_RULES.find(rule => rule.name === "worktree-write-outside-manifest")!, {
  "file": "packages/cezar/src/worktree-skill-cleanup.ts",
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

// Pin the former grammar's destructuring, nesting and schema exceptions.
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

// Pin the former grammar's destructuring, nesting and schema exceptions.
ruleCases(AST_RULES.find(rule => rule.name === "run-search-field-list-outside-contract")!, {
  "file": "packages/cezar/src/workflows/run/fixture.ts",
  "valid": [
    "const x = [run['branch'], run.workflow]"
  ],
  "invalid": [
    {
      "code": "const x = [[run.branch, run.workflow]]",
      "errors": 2
    }
  ]
});

// Pin the former grammar's destructuring, nesting and schema exceptions.
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

// Pin the former grammar's destructuring, nesting and schema exceptions.
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

// The former public_field_definition grammar also covered class accessors.
ruleCases(AST_RULES.find(rule => rule.name === 'run-memory-field-outside-owner')!, {
  file: 'packages/cezar/src/workflows/run/fixture.ts',
  valid: [
    'class A { accessor byRun = new WeakSet() }',
    'abstract class A { abstract byRun: Map<string, string> }',
    'abstract class A { abstract accessor byRun: Map<string, string> }',
  ],
  invalid: [
    'class A { accessor byRun = new Map() }',
    'class A { static accessor byRun = new Set() }',
    'class A { accessor #byRun = new WeakMap() }',
  ],
});


it('exempts only the launch read resolver from the skill reader rule', () => {
  const rule = AST_RULES.find(rule => rule.name === 'skills-read-outside-enabled-skills')!;
  expect(rule.applies('packages/cezar/src/workflows/run/launch-read-resolver.ts')).toBe(false);
  expect(rule.applies('packages/cezar/src/workflows/run/skills-reader.ts')).toBe(true);
  expect(rule.applies('packages/cezar/src/workflows/run.ts')).toBe(true);
});
