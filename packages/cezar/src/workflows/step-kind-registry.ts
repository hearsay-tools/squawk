import { createKeyedRegistry } from '../core/registry.ts';
import type { WorkflowStepDef } from './types.ts';

/** Session steps control the loop; finite steps share check-style pass/fail and retry handling. */
export type StepKindOutcome = { kind: 'result'; ok: boolean; output: string } |
  { kind: 'next' | 'settle' | 'handed-off' };

export interface StepKindContext {
  step: WorkflowStepDef;
  runId: string;
  cwd: string;
  emit(event: { type: string; stepId?: string; [key: string]: unknown }): void;
  isCancelled(): boolean;
  setInterrupt(stop: () => void): void;
  runAgent(): Promise<StepKindOutcome>;
  runCheck(): Promise<{ ok: boolean; output: string }>;
}

export interface StepKindDefinition {
  kind: string;
  requiresRunner: boolean;
  /** Throw a descriptive error when the plugin configuration is invalid. */
  validate?(step: WorkflowStepDef): void;
  execute(context: StepKindContext): Promise<StepKindOutcome>;
}

const registry = createKeyedRegistry<string, StepKindDefinition>({
  name: 'Workflow step kinds',
  bootHint: 'Call registerBuiltInStepKinds(), register plugins, then sealStepKinds() at boot.',
});

export function registerStepKind(definition: StepKindDefinition): void {
  if (!definition.kind || definition.kind.length > 64 || definition.kind === 'plugin') {
    throw new Error(`Invalid workflow step kind '${definition.kind}'`);
  }
  registry.register(definition.kind, definition);
}
export const sealStepKinds = registry.seal;
export const stepKindsSealed = registry.isSealed;
export const registeredStepKinds = registry.values;
export function stepKindDefinition(kind: string): StepKindDefinition {
  const definition = registry.get(kind);
  if (!definition) throw new Error(`Unknown workflow step kind '${kind}'`);
  return definition;
}
/** A cold workflow loader does not boot the execution engine. */
export function knownStepKinds(): readonly string[] | undefined {
  return registry.isSealed() ? registry.keys() : undefined;
}

const agent: StepKindDefinition = {
  kind: 'agent', requiresRunner: true,
  execute: context => context.runAgent(),
};
const check: StepKindDefinition = {
  kind: 'check', requiresRunner: false,
  execute: async context => ({ kind: 'result', ...await context.runCheck() }),
};
/** Register only. Plugins register before the boot boundary seals the registry. */
export function registerBuiltInStepKinds(): void {
  registerStepKind(agent);
  registerStepKind(check);
}
export function sealBuiltInStepKinds(): void { sealStepKinds(); }
