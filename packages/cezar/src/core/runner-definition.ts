import type { AgentRunner, AgentRunSpecSupport, RunnerId } from './agent-runner.ts';
import type { RunnerFacts } from './runner-facts.ts';
import type { BackendModelMap } from './model-identity.ts';
import type { AgentModelSettingsStrategy } from './runner-model-settings.ts';
import type { ModelOption } from './runner-model-catalog.ts';
import type { SkillCatalog } from './runner-skill-catalog.ts';
import type { SkillDiscoveryOptions } from './skill-probe.ts';
import type { ConfigFileDef } from './runner-config-files.ts';
import type { ProviderCommandResult, ProviderConnectionState } from './provider-auth.ts';

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

  // Login, accounts, home paths and environment (hearsay-tools/squawk#3894).
  /** Login and auth-status data (the `login` part). */
  readonly login: RunnerLogin;
  /** Imports the runner's status parser (`runners/<id>/login-probe.ts`). */
  loadLogin(): Promise<RunnerLoginStatus>;
  /** Account folder layout, profile markers, home slot (the `accounts` part). */
  readonly accounts: RunnerAccounts;
  /** The environment allow-list prefixes (the `env` part). */
  readonly env: RunnerEnv;

  // The native mock and its scenario adapter (hearsay-tools/squawk#3899).
  /** The runner's native mock script and the prompts that drive it, for tests and lint (the `mock` part). */
  readonly mock: RunnerMock;
}

/**
 * A runner's native mock (the `mock` part): the script in `packages/cezar/scripts/`, the variable
 * that points the runner at it, and the prompt each shared parity scenario sends it. Plain data in
 * `runners/<id>/mock.ts`. `core/skill-probe.ts` and the parity kit read it from the registry, and
 * `lint/mock-scenario-boundary.ts` reads it from the built-in list.
 */
export interface RunnerMock {
  /** The mock script's file name in `packages/cezar/scripts/`. */
  readonly script: string;
  /** The env var the runner reads to locate its binary; a test points it at the mock script. */
  readonly binEnv: string;
  /** Every human ask wire this runner exposes; cezar_ask when it has no native one. */
  readonly askResumeCases: readonly { kind: string; scenario: 'ask-resume'; answer: string }[];
  /**
   * Scenario name -> the prompt text this runner's mock answers it with. The names are the parity
   * kit's `ScenarioName`s; `parity-classes.test.ts` checks each. The kit adds the `cezar-ask` and
   * `cezar-wait` prompts, which every mock answers the same way.
   */
  readonly scenarios: Readonly<Record<string, string>>;
  /** P1: the option to pick (matched case-insensitively against its label) and the text the
   *  mock echoes once that native reply arrives. Required with `scenarios.approval`. */
  readonly approvalDecisions?: readonly { pick: string; echo: string }[];
  /** P6: the text the mock echoes once Squawk refuses its malformed request. Required with
   *  `scenarios['approval-malformed']`. */
  readonly malformedApprovalEcho?: string;
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

/** Login and auth status (the `login` part, spec 2026-11-18-runner-definitions): the data half of
 *  a `DESCRIPTORS` entry from `core/provider-auth.ts`, read by `ProviderAuthService`. */
export interface RunnerLoginData {
  /** Args that ask the CLI whether it is logged in. */
  readonly statusArgs: readonly string[];
  /** Args that log the CLI in. */
  readonly loginArgs: readonly string[];
  /** Shown when the CLI is not installed. */
  readonly installHint: string;
  /** A larger output ceiling for a status command whose output grows with the user's setup. */
  readonly maxBuffer?: number;
}

/** {@link RunnerLoginData} plus the code half: the executable resolution. */
export interface RunnerLogin extends RunnerLoginData {
  /** The auth probe's executable, honoring the runner's `HSQ_*_BIN` override. Code, not data:
   *  it stays in the definition (`runners/<id>/definition.ts`) so its `productEnv` read keeps a
   *  literal suffix (cez/product-env-read). */
  executable(): string;
}

/** The code half of `login`: how a CLI's answer becomes a connection state. Loads from
 *  `runners/<id>/login-probe.ts`, so a definition module imports no parser code. */
export interface RunnerLoginStatus {
  parse(result: ProviderCommandResult): ProviderConnectionState | null;
}

/** How one runner lays out an account, declared once per runner. Moved verbatim from
 *  `core/agent-profiles.ts` (`AccountLayout`). */
export interface AccountLayout {
  /**
   * The variable Squawk sets to the account folder so the CLI opens that login. null: the provider
   * carries no named accounts.
   */
  readonly envVar: string | null;
  /**
   * Whether a worker binding of the default account pins its discovered home. false: the default
   * spawns bare and follows the host env. A machine where the agent never ran has no home to pin.
   */
  readonly defaultBindsHome: boolean;
  /**
   * Where the login state file sits for the discovered home. `beside-home`: next to it (Claude's
   * `.claude.json`, see `claudeStateFilePath`), so a worker binds the home the child env resolves
   * and records that layout. `in-home`: inside the account folder.
   */
  readonly stateFile: 'in-home' | 'beside-home';
}

/** Account relocation, profile markers and the home slot (the `accounts` part, spec
 *  2026-11-18-runner-definitions): the rows of `ACCOUNT_LAYOUT`, `PROFILE_DIR_MARKERS` and
 *  `AGENT_HOME_SLOT`, moved from `core/agent-profiles.ts` and `paths.ts`. */
export interface RunnerAccounts {
  /** How this runner lays out an account. */
  readonly layout: AccountLayout;
  /** What the agent drops into its home on first login. Any one is enough. */
  readonly dirMarkers: readonly string[];
  /** The `AgentHomePaths` slot that holds this runner's account home. Typed `string` here because
   *  core may not import the catalog's type; `runners/<id>/accounts.ts` checks the key against
   *  `keyof AgentHomePaths`, and `agentHomeSlot` (paths.ts) returns that type. */
  readonly homeSlot: string;
}

/** The environment allow-list prefixes (the `env` part, spec 2026-11-18-runner-definitions): the
 *  runner's row of `BACKEND_ALLOW_PREFIXES`, moved from `core/agent-env.ts`. */
export interface RunnerEnv {
  /** Per-backend auth/config the runner genuinely needs, by prefix. */
  readonly allowPrefixes: readonly string[];
}

/** Declare one runner. */
export function defineRunner(definition: RunnerDefinition): RunnerDefinition {
  return definition;
}
