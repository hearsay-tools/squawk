import { defineRunner } from '../../core/runner-definition.ts';
import { PI_FACTS } from './facts.ts';
import { PI_MODELS } from './models.ts';
import { PI_CONFIG_FILES } from './config-files.ts';
import { PI_EXTRA_TOOLS } from './extra-tools.ts';
import { PI_SPEC_SUPPORT } from './spec-support.ts';
import { PI_DETECTION } from './detection.ts';
import { PI_CLI } from './cli.ts';
import { PI_LOGIN } from './login.ts';

/** The Pi runner. */
export const piRunner = defineRunner({
  id: 'pi',
  facts: PI_FACTS,
  specSupport: PI_SPEC_SUPPORT,
  detection: PI_DETECTION,
  cli: PI_CLI,
  loadAdapter: async () => new (await import('../../core/pi-runner.ts')).PiRunner(),
  models: {
    ...PI_MODELS,
    loadSettings: async () => (await import('../../agent-config/model-settings/pi.ts')).piModelSettingsStrategy,
  },
  loadModelCatalog: async () => (await import('../../core/pi-model-catalog.ts')).discoverPiModels,
  loadSkillCatalog: async () => (await import('../../core/pi-skill-catalog.ts')).discoverPiSkills,
  configFiles: PI_CONFIG_FILES,
  extraTools: PI_EXTRA_TOOLS,
  login: PI_LOGIN,
  loadLogin: async () => ({ parse: (await import('./login-probe.ts')).parsePiStatus }),
});
