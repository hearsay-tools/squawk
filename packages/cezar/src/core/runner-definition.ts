import type { AgentRunner, AgentRunSpecSupport, RunnerId } from './agent-runner.ts';
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

  // Facts, spec support, detection, CLI and install source (slice B1).
  /** Which `AgentRunSpec` fields the runner's wire honors. The adapter class reads the same data file. */
  readonly specSupport: AgentRunSpecSupport;
  /** How the host probe finds the runner's CLI and reads its version. Core runs the probe. */
  readonly detection: RunnerDetection;
  /** How a terminal starts the runner's CLI, and where the installer gets it. */
  readonly cli: RunnerCli;

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

/** A runner's model data: plain data in `runners/<id>/models.ts`. */
export interface RunnerModelData {
  /**
   * Known preset ids, for mismatch checks (`core/model-presets.ts`). This is not a whitelist:
   * unknown custom ids remain valid. OpenCode uses native discovery plus a structural guard.
   */
  readonly known: readonly string[];
  /** How a model id maps to a provider and to the wire (`core/model-identity.ts`). */
  readonly idMap: BackendModelMap;
}

/** A runner's `models` part: its model data and the reader of its native default model. */
export interface RunnerModels extends RunnerModelData {
  /** Imports the runner's native-settings policy: vendor precedence, environment and provider. */
  loadSettings(): Promise<AgentModelSettingsStrategy>;
}

/** How the host probe finds a runner's CLI (`detectEnvironment`, `core/backend-detect.ts`). */
export interface RunnerDetection {
  /** The CLI's name on PATH. */
  readonly binary: string;
  /** The executable the host configured through the runner's `*_BIN` setting, if any. It replaces `binary`. */
  readonly binOverride: () => string | undefined;
  /**
   * What `DRY_RUN=1` reports. `always`: the bundled mock stands in, so the CLI counts as present
   * without a spawn. `unless-bin-override`: the same, except that an explicit `binOverride`
   * outranks the mock in the runner, so the probe still spawns it.
   */
  readonly dryRun: 'always' | 'unless-bin-override';
  /**
   * A version line the CLI must print. A binary whose `--version` output does not match is not
   * this CLI (a shell wrapper or an unrelated tool on PATH), and the probe reports it absent.
   */
  readonly banner?: { readonly pattern: RegExp; readonly label: string };
  /** The hint that goes with a CLI that answered. */
  readonly availableHint: string;
  /** The hint that goes with a CLI that did not answer. */
  readonly missingHint: string;
}

/**
 * How a terminal starts each runner's own CLI, the take-over command of "Open in terminal" and
 * the cockpit's copyable resume line (hearsay-tools/squawk#3642), and where the installer gets it.
 */
export interface RunnerCli {
  /**
   * The executable a terminal runs. `path-name`: the CLI's name on PATH. `configured`: the
   * executable the server resolves from its `HSQ_*_BIN` override, so only the server can spell it.
   */
  readonly terminalExecutable: { readonly kind: 'path-name'; readonly name: string } | { readonly kind: 'configured'; readonly resolve: () => string };
  /** The arguments that reopen a recorded session, after the executable. */
  readonly resumeArgs: (sessionId: string) => string;
  /** Where the installer gets the CLI: an npm package, a site the operator installs from, or nowhere it knows. */
  readonly installSource: { readonly npm: string } | { readonly site: string; readonly label: string } | null;
}

/** Declare one runner. */
export function defineRunner(definition: RunnerDefinition): RunnerDefinition {
  return definition;
}
