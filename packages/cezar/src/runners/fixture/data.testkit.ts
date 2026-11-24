import type { AgentRunSpecSupport } from '../../core/agent-runner.ts';
import { SQUAWK_SIDE_SPEC_SUPPORT } from '../../core/agent-runner-values.ts';
import type { RunnerFacts } from '../../core/runner-facts.ts';
import type { RunnerAccountsData, RunnerCli, RunnerDetection, RunnerDisplay, RunnerEnv, RunnerLoginData, RunnerModelData } from '../../core/runner-definition.ts';

/**
 * The data of the fixture runner: a registered runner that no built-in list names, used by the parity
 * kit's own tests. Data only, as every `runners/<id>/*.ts` data file is: the definition and the adapter
 * read it, so importing it loads no adapter. The runner's files end in `.testkit.ts`, so no production
 * file can import them and the runner-class guard (`runner-class-rule.test.ts`) does not list them.
 */

/** What the fixture mock's wire can do: JSON prompt lines on stdin, observable consumption, direct Squawk tool IPC. */
export const FIXTURE_FACTS = {
  shutdownDescendants: 'process-group',
  skillTriggerMidTurn: false, skillUnknownName: 'silent', skillsSeenBySession: 'at-start',
  childWork: 'none', hookEvents: 'none', nativePermission: 'none', transport: 'stdio', humanPromptHold: 'none',
  inputDelivery: {
    mode: 'steer', consumption: 'observable', acknowledgement: 'write', humanInputAtTurnEnd: 'held-when-late',
    via: 'JSON prompt line on stdin with id; echoed as a consumed frame',
  },
  systemPromptOnResume: 'resent',
  nativeAsk: 'none', nativeSubagents: 'unreported', nativeTimerTool: null, costReport: 'per-turn', sessionIdSource: 'launch',
  claudeModelAliases: false,
  turnStart: 'on-write',
} as const satisfies RunnerFacts;

const UNMAPPED = 'The fixture mock reads JSON prompt lines and nothing else';

export const FIXTURE_SPEC_SUPPORT: AgentRunSpecSupport = {
  ...SQUAWK_SIDE_SPEC_SUPPORT,
  systemPrompt: { honored: true, via: '--append-system-prompt' },
  squawkTools: { honored: true, via: 'direct Squawk tool IPC over CEZ_TOOL_SOCKET' },
  userPrompt: { honored: true, via: 'stdin line {"type":"prompt","text":...}' },
  skill: { honored: false, reason: UNMAPPED },
  resumeFallbackSkill: { honored: false, reason: UNMAPPED },
  images: { honored: false, reason: UNMAPPED },
  cwd: { honored: true, via: 'spawn cwd' },
  toolGrant: { honored: false, reason: 'The fixture mock runs no tools' },
  restrictCrossSessionMessaging: { honored: false, reason: 'The fixture mock has no cross-session tool' },
  minimal: { honored: false, reason: UNMAPPED },
  additionalDirectories: { honored: false, reason: UNMAPPED },
  env: { honored: true, via: 'merged over the child env through buildChildEnv' },
  model: { honored: false, reason: UNMAPPED },
  effort: { honored: false, reason: UNMAPPED },
  timeoutMs: { honored: true, via: 'wall-clock kill switch' },
  sessionId: { honored: true, via: '--session-id / --resume' },
  resume: { honored: true, via: '--resume <sessionId>' },
  resumeFallbackSystemPrompt: { honored: false, reason: UNMAPPED },
};

/** The env var the adapter reads for the mock's path, as `binEnv` of the `mock` part names it. */
export const FIXTURE_BIN_ENV = 'FIXTURE_RUNNER_BIN';

export const FIXTURE_DETECTION = {
  binary: 'fixture-runner',
  binOverride: () => process.env[FIXTURE_BIN_ENV],
  dryRun: 'always',
  availableHint: 'the fixture runner needs no login',
  missingHint: 'the fixture runner is a test double',
} as const satisfies RunnerDetection;

export const FIXTURE_CLI = {
  terminalExecutable: { kind: 'path-name', name: 'fixture-runner' },
  resumeArgs: id => `--resume ${id}`,
  installSource: null,
  openTarget: { label: 'Fixture CLI', icon: 'fixture' },
} as const satisfies RunnerCli;

export const FIXTURE_MODELS: RunnerModelData = {
  suggested: [{ id: '', label: 'auto', desc: 'The fixture mock has one model' }],
  retired: [],
  known: [],
  idMap: {},
};

export const FIXTURE_LOGIN = {
  statusArgs: ['status'],
  loginArgs: ['login'],
  installHint: 'The fixture runner is a test double; there is nothing to install.',
} as const satisfies RunnerLoginData;

export const FIXTURE_ACCOUNTS = {
  layout: { envVar: null, defaultBindsHome: false, stateFile: 'in-home' },
  dirMarkers: [],
  homeSlot: 'fixture',
} as const satisfies RunnerAccountsData;

export const FIXTURE_ENV = { allowPrefixes: ['FIXTURE_'] } as const satisfies RunnerEnv;

export const FIXTURE_DISPLAY = {
  displayName: 'Fixture',
  modelListName: 'Fixture',
  modelIdScope: 'own',
  pickerLabel: 'Fixture',
  pickerDescription: 'A test double over a small mock script',
  icon: 'bot',
  installHint: 'none',
  loginCommand: 'fixture-runner login',
} as const satisfies RunnerDisplay;
