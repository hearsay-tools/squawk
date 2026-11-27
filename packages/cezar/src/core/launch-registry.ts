/**
 * The launch slot (spec 2026-11-26-launch-slot-and-bundled-jobs § 1-3). Features and host plugins
 * register launch parts. Each agent launch resolves them once, in ascending `order`, into session
 * env entries and system-prompt parts. Core knows no feature names.
 */
import type { Home } from '../home/home.ts';
import { createKeyedRegistry } from './registry.ts';

/** The cockpit a launch can reach, or undefined when no cockpit is attached. */
export type LaunchCockpitAddress = { readonly origin: string; readonly projectId: string } | undefined;

/** What a launch part reads. `env` holds the profile env and the entries of earlier parts. */
export interface LaunchPartContext {
  readonly runId: string;
  readonly dataDir: string;
  readonly repoRoot: string;
  readonly home: Home;
  readonly cockpit: LaunchCockpitAddress;
  readonly env: Readonly<Record<string, string>>;
}

/** What one launch part adds to a launch. */
export interface LaunchPartContribution {
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly prompt?: string | undefined;
}

export interface LaunchPartDefinition {
  readonly id: string;
  /** Parts run in ascending order; ties keep registration order. Default 100. */
  readonly order?: number | undefined;
  contribute(context: LaunchPartContext): LaunchPartContribution | undefined | Promise<LaunchPartContribution | undefined>;
}

/** The merged result of every launch part. */
export interface ResolvedLaunchParts {
  env: Record<string, string>;
  prompts: string[];
}

export const DEFAULT_LAUNCH_PART_ORDER = 100;

const parts = createKeyedRegistry<string, LaunchPartDefinition>({
  name: 'Launch parts',
  bootHint: 'register every launch part, then call sealLaunchParts() at the runtime boot boundary (boot.ts), or import a testkit that seals it.',
});

function checkShape(part: LaunchPartDefinition): void {
  if (typeof part !== 'object' || part === null) throw new Error('Launch parts: a launch part must be an object.');
  if (typeof part.id !== 'string' || part.id.length === 0) throw new Error(`Launch parts: invalid id ${JSON.stringify(part.id)}.`);
  if (part.order !== undefined && (typeof part.order !== 'number' || !Number.isFinite(part.order))) {
    throw new Error(`Launch parts: '${part.id}' needs a finite number order.`);
  }
  if (typeof part.contribute !== 'function') throw new Error(`Launch parts: '${part.id}' needs a contribute function.`);
}

/** Throws what `registerLaunchPart` would throw, without writing. */
export function checkLaunchPartRegistration(part: LaunchPartDefinition): void {
  checkShape(part);
  parts.check(part.id, part);
}

export function registerLaunchPart(part: LaunchPartDefinition): void {
  checkShape(part);
  parts.register(part.id, part);
}

export function sealLaunchParts(): void { parts.seal(); }

/** Whether the registry is sealed. Never throws. */
export function launchPartsSealed(): boolean { return parts.isSealed(); }

/** The registered parts in resolution order. Throws until sealed. */
export function registeredLaunchParts(): LaunchPartDefinition[] {
  // Array.prototype.sort is stable, so equal orders keep registration order.
  return parts.values().sort((a, b) => (a.order ?? DEFAULT_LAUNCH_PART_ORDER) - (b.order ?? DEFAULT_LAUNCH_PART_ORDER));
}

const defaultWarn = (message: string): void => { console.warn(message); };

/**
 * Run every launch part in order. Each part sees the env of the parts before it. A part that
 * throws or rejects is skipped with one warning; the launch goes on without it.
 */
export async function resolveLaunchParts(
  context: LaunchPartContext,
  warn: (message: string) => void = defaultWarn,
): Promise<ResolvedLaunchParts> {
  const ordered = registeredLaunchParts();
  const env: Record<string, string> = {};
  const prompts: string[] = [];
  for (const part of ordered) {
    let contribution: LaunchPartContribution | undefined;
    try {
      contribution = await part.contribute({ ...context, env: Object.freeze({ ...context.env, ...env }) });
    } catch (error) {
      warn(`Launch part '${part.id}' failed and was skipped: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (contribution?.env) Object.assign(env, contribution.env);
    if (typeof contribution?.prompt === 'string' && contribution.prompt.length > 0) prompts.push(contribution.prompt);
  }
  return { env, prompts };
}
