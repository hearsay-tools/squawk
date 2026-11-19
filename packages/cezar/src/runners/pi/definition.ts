import { defineRunner } from '../../core/runner-definition.ts';
import { PI_FACTS } from './facts.ts';
import { PI_MODELS } from './models.ts';
import { PI_CONFIG_FILES } from './config-files.ts';

/** The Pi runner. */
export const piRunner = defineRunner({
  id: 'pi',
  facts: PI_FACTS,
  loadAdapter: async () => new (await import('../../core/pi-runner.ts')).PiRunner(),
  models: {
    ...PI_MODELS,
    loadSettings: async () => (await import('../../agent-config/model-settings/pi.ts')).piModelSettingsStrategy,
  },
  loadModelCatalog: async () => (await import('../../core/pi-model-catalog.ts')).discoverPiModels,
  loadSkillCatalog: async () => (await import('../../core/pi-skill-catalog.ts')).discoverPiSkills,
  configFiles: PI_CONFIG_FILES,
  // The trio still marks the default list (hearsay-tools/cezarion#75). pi itself gets no --tools
  // allowlist for it (hearsay-tools/cezarion#1305): the default-tools extension activates these
  // names with the built-ins, so MCP and other extension tools stay callable.
  extraTools: ['Subagent', 'SubagentSupervisor', 'SubagentWait'],
});
