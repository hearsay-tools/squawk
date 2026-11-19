import { defineRunner } from '../../core/runner-definition.ts';
import { productEnv } from '../../core/product-env.ts';
import { OMP_FACTS } from './facts.ts';
import { OMP_MODELS } from './models.ts';
import { OMP_CONFIG_FILES } from './config-files.ts';
import { OMP_EXTRA_TOOLS } from './extra-tools.ts';
import { OMP_SPEC_SUPPORT } from './spec-support.ts';
import { OMP_DETECTION } from './detection.ts';
import { OMP_CLI } from './cli.ts';
import { OMP_LOGIN } from './login.ts';
import { OMP_ACCOUNTS } from './accounts.ts';
import { OMP_ENV } from './env.ts';

/** The OMP runner. */
export const ompRunner = defineRunner({
  id: 'omp',
  facts: OMP_FACTS,
  specSupport: OMP_SPEC_SUPPORT,
  detection: OMP_DETECTION,
  cli: OMP_CLI,
  loadAdapter: async () => new (await import('./omp-runner.ts')).OmpRunner(),
  models: {
    ...OMP_MODELS,
    // OMP's native default model (its model roles) is not read: no native-default strategy, by the
    // spec's scope (§ Model selection). Returning nothing leaves the prompt unpinned, so OMP's own
    // model roles apply.
    loadSettings: async () => ({ runner: 'omp', async read() { return {}; } }),
  },
  loadModelCatalog: async () => (await import('./omp-model-catalog.ts')).discoverOmpModels,
  loadSkillCatalog: async () => (await import('./omp-skill-catalog.ts')).discoverOmpSkills,
  configFiles: OMP_CONFIG_FILES,
  extraTools: OMP_EXTRA_TOOLS,
  login: { ...OMP_LOGIN, executable: () => productEnv('OMP_BIN') ?? 'omp' },
  accounts: OMP_ACCOUNTS,
  env: OMP_ENV,
  loadLogin: async () => ({ parse: (await import('./login-probe.ts')).parseOmpStatus }),
});
