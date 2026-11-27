// External plain-JS ACP runner plugin for `<config>/plugins/`: no build step, imports Squawk only
// through `@hearsay-tools/squawk/plugin` and its `/runtime` and `/acp` subpaths.
import { defineRunner, SQUAWK_SIDE_SPEC_SUPPORT } from '@hearsay-tools/squawk/plugin';
import { join } from 'node:path';

export const RUNNER_ID = 'ext-acp-runner';
const MOCK = { script: 'mock-acp.mjs', binEnv: 'EXT_ACP_BIN', askResumeCases: [], scenarios: {} };
const UNSUPPORTED = 'External ACP proof runner keeps its surface minimal';

const facts = {
  shutdownDescendants: 'process-group',
  skillTriggerMidTurn: false, skillUnknownName: 'silent', skillsSeenBySession: 'at-start',
  childWork: 'none', hookEvents: 'none', nativePermission: 'none', transport: 'stdio', humanPromptHold: 'none',
  inputDelivery: {
    mode: 'steer', consumption: 'observable', acknowledgement: 'first-work', humanInputAtTurnEnd: 'held-when-late',
    via: 'ACP session/prompt over stdio',
  },
  systemPromptOnResume: 'resent',
  nativeAsk: 'none', nativeSubagents: 'unreported', nativeTimerTool: null, costReport: 'per-turn', sessionIdSource: 'launch',
  claudeModelAliases: false,
  turnStart: 'on-write',
};

const specSupport = {
  ...SQUAWK_SIDE_SPEC_SUPPORT,
  systemPrompt: { honored: false, reason: UNSUPPORTED },
  squawkTools: { honored: true, via: 'HTTP MCP bridge over AcpTransport' },
  userPrompt: { honored: true, via: 'ACP session/prompt text content block' },
  skill: { honored: false, reason: UNSUPPORTED },
  resumeFallbackSkill: { honored: false, reason: UNSUPPORTED },
  images: { honored: false, reason: UNSUPPORTED },
  cwd: { honored: true, via: 'ACP session/new cwd' },
  toolGrant: { honored: false, reason: UNSUPPORTED },
  restrictCrossSessionMessaging: { honored: false, reason: UNSUPPORTED },
  minimal: { honored: false, reason: UNSUPPORTED },
  additionalDirectories: { honored: false, reason: UNSUPPORTED },
  env: { honored: true, via: 'buildChildEnv' },
  model: { honored: false, reason: UNSUPPORTED },
  effort: { honored: false, reason: UNSUPPORTED },
  timeoutMs: { honored: false, reason: UNSUPPORTED },
  sessionId: { honored: false, reason: UNSUPPORTED },
  resume: { honored: false, reason: UNSUPPORTED },
  resumeFallbackSystemPrompt: { honored: false, reason: UNSUPPORTED },
};

const externalAcpRunner = defineRunner({
  id: RUNNER_ID,
  facts,
  specSupport,
  detection: {
    binary: 'ext-acp-agent',
    binOverride: () => undefined,
    dryRun: 'always',
    availableHint: 'uses mock-acp.mjs via nativeMockPath',
    missingHint: 'uses mock-acp.mjs via nativeMockPath',
  },
  cli: {
    terminalExecutable: { kind: 'path-name', name: 'ext-acp-agent' },
    resumeArgs: id => `--resume ${id}`,
    installSource: null,
    openTarget: { label: 'External ACP', icon: 'bot' },
  },
  loadAdapter: async () => new (await import('./adapter.mjs')).ExternalAcpAdapter({ facts, specSupport, mock: MOCK }),
  models: {
    suggested: [{ id: '', label: 'auto', desc: 'Default ACP model' }],
    retired: [],
    known: [],
    idMap: {},
    loadSettings: async () => ({ runner: RUNNER_ID, async read() { return {}; } }),
  },
  loadModelCatalog: async () => async () => [],
  loadSkillCatalog: async () => async () => ({ runner: RUNNER_ID, source: 'live', skills: [], problems: [] }),
  configFiles: { files: [], agentConfig: { label: 'External ACP', groups: [] } },
  extraTools: [],
  login: {
    statusArgs: ['--version'],
    loginArgs: null,
    installHint: 'No login needed for mock ACP runner.',
    executable: () => process.execPath,
  },
  loadLogin: async () => ({ parse: () => 'connected' }),
  accounts: {
    layout: { envVar: 'EXT_ACP_HOME', defaultBindsHome: false, stateFile: 'in-home' },
    dirMarkers: [],
    homeSlot: 'extAcpRunner',
    homeDir: (_env, home) => join(home, '.ext-acp-agent'),
  },
  env: { allowPrefixes: ['EXT_ACP_'] },
  mock: MOCK,
  display: {
    displayName: 'External ACP Runner',
    modelListName: 'External ACP',
    modelIdScope: 'own',
    pickerLabel: 'External ACP Runner',
    pickerDescription: 'Plain-JS ACP runner plugin built on @hearsay-tools/squawk/plugin/acp',
    icon: 'bot',
    installHint: 'none',
    loginCommand: 'ext-acp-agent login',
  },
});

export default function setup(api) {
  api.registerRunner(externalAcpRunner);
}
