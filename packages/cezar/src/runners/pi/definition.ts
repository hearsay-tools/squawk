import { defineRunner } from '../../core/runner-definition.ts';
import { PI_FACTS } from './facts.ts';
import { PI_MODELS } from './models.ts';

/** The Pi runner. */
export const piRunner = defineRunner({
  id: 'pi',
  facts: PI_FACTS,
  loadAdapter: async () => new (await import('../../core/pi-runner.ts')).PiRunner(),
  models: {
    ...PI_MODELS,
    loadSettings: async () => (await import('../../agent-config/model-settings/pi.ts')).piModelSettingsStrategy,
  },
});
