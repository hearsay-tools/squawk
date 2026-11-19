import type { AgentRunner, RunnerId } from './agent-runner.ts';
import type { RunnerFacts } from './runner-facts.ts';
import type { BackendModelMap } from './model-identity.ts';
import type { AgentModelSettingsStrategy } from './runner-model-settings.ts';
import type { ModelOption } from './runner-model-catalog.ts';
import type { SkillCatalog } from './runner-skill-catalog.ts';
import type { SkillDiscoveryOptions } from './skill-probe.ts';
import type { ConfigFileDef } from './runner-config-files.ts';

/**
 * Everything Squawk knows about one runner, in one object (spec 2026-11-18-runner-definitions).
 * Each runner's `runners/<id>/definition.ts` exports one, made with `defineRunner`, and an entry
 * registers it with `registerRunner` (`core/runner-registry.ts`). Plain data sits in the object;
 * the adapter loads on demand through `loadAdapter`. A definition module imports only types and
 * data, so importing it loads no adapter until `loadAdapter` runs. Later slices add parts.
 */
export interface RunnerDefinition {
  /** The runner id. */
  readonly id: RunnerId;
  /** What the runner's wire can do (`RunnerFacts`). */
  readonly facts: RunnerFacts;
  /** Imports the adapter module and builds a new runner. */
  loadAdapter(): Promise<AgentRunner>;

  // Models, skills, config files and extra tools (hearsay-tools/squawk#3895).
  /** The model presets, the model id map and the reader of the native default model. */
  readonly models: RunnerModels;
  /** Imports the runner's model catalog adapter, which lists the models its CLI offers. */
  loadModelCatalog(): Promise<(options: { cwd: string }) => Promise<ModelOption[]>>;
  /** Imports the runner's skill list adapter, which lists the skills its CLI sees. */
  loadSkillCatalog(): Promise<(options: SkillDiscoveryOptions) => Promise<SkillCatalog>>;
  /** The native config files that Settings → Agent config shows, in presentation order. */
  readonly configFiles: readonly ConfigFileDef[];
  /** Extra tools unioned onto the default when a step does not set allowedTools. */
  readonly extraTools: readonly string[];
}

/** One model the picker suggests. `id: ''` is auto: the runner picks. */
export interface RunnerModelPreset {
  readonly id: string;
  readonly label: string;
  readonly desc: string;
}

/** A runner's model data: plain data in `runners/<id>/models.ts`. */
export interface RunnerModelData {
  /** The picker presets, as the cockpit's `MODELS_BY_RUNNER` lists them until C2 reads these. */
  readonly suggested: readonly RunnerModelPreset[];
  /**
   * Known preset ids, for mismatch checks (`core/model-presets.ts`). This is not a whitelist:
   * unknown custom ids remain valid. OpenCode uses native discovery plus a structural guard.
   */
  readonly known: readonly string[];
  /** Retired dated ids this runner served. Another runner still refuses them as known foreign ids. */
  readonly retired: readonly string[];
  /** How a model id maps to a provider and to the wire (`core/model-identity.ts`). */
  readonly idMap: BackendModelMap;
}

/** A runner's `models` part: its model data and the reader of its native default model. */
export interface RunnerModels extends RunnerModelData {
  /** Imports the runner's native-settings policy: vendor precedence, environment and provider. */
  loadSettings(): Promise<AgentModelSettingsStrategy>;
}

/** Declare one runner. */
export function defineRunner(definition: RunnerDefinition): RunnerDefinition {
  return definition;
}
