import { defineRunner } from '../../core/runner-definition.ts';
import {
  FIXTURE_ACCOUNTS, FIXTURE_CLI, FIXTURE_DETECTION, FIXTURE_DISPLAY, FIXTURE_ENV, FIXTURE_FACTS, FIXTURE_LOGIN, FIXTURE_MOCK,
  FIXTURE_MODELS, FIXTURE_SPEC_SUPPORT,
} from './data.testkit.ts';

/**
 * The fixture runner (hearsay-tools/squawk#3899): a definition over a small mock script, in test files only.
 * A test registers it with `registerRunner`; no built-in list names it and no production file imports it.
 */
export const fixtureRunner = defineRunner({
  id: 'fixture',
  facts: FIXTURE_FACTS,
  specSupport: FIXTURE_SPEC_SUPPORT,
  detection: FIXTURE_DETECTION,
  cli: FIXTURE_CLI,
  loadAdapter: async () => new (await import('./fixture-adapter.testkit.ts')).FixtureAdapter(),
  models: { ...FIXTURE_MODELS, loadSettings: async () => ({ runner: 'fixture', async read() { return {}; } }) },
  loadModelCatalog: async () => async () => [],
  loadSkillCatalog: async () => async () => ({ runner: 'fixture', source: 'live', skills: [], problems: [] }),
  configFiles: { files: [], agentConfig: { label: 'Fixture', groups: [] } },
  extraTools: [],
  login: { ...FIXTURE_LOGIN, executable: () => 'fixture-runner' },
  loadLogin: async () => ({ parse: result => (result.exitCode === 0 ? 'connected' : null) }),
  accounts: FIXTURE_ACCOUNTS,
  env: FIXTURE_ENV,
  mock: FIXTURE_MOCK,
  display: FIXTURE_DISPLAY,
});
