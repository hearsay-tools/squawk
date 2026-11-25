// An external runner plugin as an operator would drop it into `<config>/plugins/`: plain JS, no
// build step, and no import from Squawk but `@hearsay-tools/squawk/plugin` and its kit subpaths.
// The runner drives `agent.mjs`, its own CLI, which sits next to this file.
import { defineRunner, SQUAWK_SIDE_SPEC_SUPPORT } from '@hearsay-tools/squawk/plugin';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RUNNER_ID = 'ext-runner';
const agent = fileURLToPath(new URL('./agent.mjs', import.meta.url));
const NOT_CARRIED = 'The external agent reads JSON prompt lines and nothing else';

export const facts = {
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
};

export const specSupport = {
  ...SQUAWK_SIDE_SPEC_SUPPORT,
  systemPrompt: { honored: false, reason: NOT_CARRIED },
  squawkTools: { honored: true, via: 'direct Squawk tool IPC over the tool socket' },
  userPrompt: { honored: true, via: 'stdin line {"type":"prompt","text":...}' },
  skill: { honored: false, reason: NOT_CARRIED },
  resumeFallbackSkill: { honored: false, reason: NOT_CARRIED },
  images: { honored: false, reason: NOT_CARRIED },
  cwd: { honored: true, via: 'spawn cwd' },
  toolGrant: { honored: false, reason: 'The external agent runs no tools of its own' },
  restrictCrossSessionMessaging: { honored: false, reason: 'The external agent has no cross-session tool' },
  minimal: { honored: false, reason: NOT_CARRIED },
  additionalDirectories: { honored: false, reason: NOT_CARRIED },
  env: { honored: true, via: 'merged over the child env through buildChildEnv' },
  model: { honored: true, via: '--model' },
  effort: { honored: false, reason: NOT_CARRIED },
  timeoutMs: { honored: false, reason: 'The external agent has no time limit of its own' },
  sessionId: { honored: true, via: '--session-id / --resume' },
  resume: { honored: true, via: '--resume <sessionId>' },
  resumeFallbackSystemPrompt: { honored: false, reason: NOT_CARRIED },
};

const externalRunner = defineRunner({
  id: RUNNER_ID,
  facts,
  specSupport,
  detection: {
    binary: 'ext-agent',
    binOverride: () => undefined,
    dryRun: 'always',
    availableHint: 'the external agent ships with its plugin',
    missingHint: 'the external agent ships with its plugin',
  },
  cli: {
    terminalExecutable: { kind: 'path-name', name: 'ext-agent' },
    resumeArgs: id => `--resume ${id}`,
    installSource: null,
    openTarget: { label: 'External agent', icon: 'ext' },
  },
  loadAdapter: async () => new (await import('./adapter.mjs')).ExternalAdapter({ agent, facts, specSupport }),
  models: {
    suggested: [{ id: '', label: 'auto', desc: 'The external agent picks its own model' }],
    retired: [],
    known: [],
    idMap: {},
    loadSettings: async () => ({ runner: RUNNER_ID, async read() { return {}; } }),
  },
  loadModelCatalog: async () => async () => [],
  loadSkillCatalog: async () => async () => ({ runner: RUNNER_ID, source: 'live', skills: [], problems: [] }),
  configFiles: { files: [], agentConfig: { label: 'External', groups: [] } },
  extraTools: [],
  login: {
    statusArgs: [agent, 'status'],
    loginArgs: null,
    installHint: 'The external agent ships with its plugin.',
    executable: () => process.execPath,
  },
  loadLogin: async () => ({ parse: result => (result.exitCode === 0 ? 'connected' : null) }),
  accounts: {
    // A named account is a folder the agent reads from EXT_AGENT_HOME.
    layout: { envVar: 'EXT_AGENT_HOME', defaultBindsHome: false, stateFile: 'in-home' },
    dirMarkers: [],
    homeSlot: 'extRunner',
    homeDir: (_env, home) => join(home, '.ext-agent'),
  },
  env: { allowPrefixes: ['EXT_AGENT_'] },
  mock: { script: 'none', binEnv: 'EXT_AGENT_BIN', askResumeCases: [], scenarios: {} },
  display: {
    displayName: 'External Runner',
    modelListName: 'External',
    modelIdScope: 'own',
    pickerLabel: 'External Runner',
    pickerDescription: 'A runner loaded from <config>/plugins/',
    icon: 'bot',
    installHint: 'none',
    loginCommand: 'ext-agent login',
  },
});

/** The plugin's setup: Squawk calls it once at boot with the plugin API. */
export default function setup(api) {
  api.registerRunner(externalRunner);
}
