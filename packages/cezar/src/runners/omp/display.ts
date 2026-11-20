import type { RunnerDisplay } from '../../core/runner-definition.ts';

/** How the cockpit and server messages name the OMP runner (its `display` part). */
export const OMP_DISPLAY = {
  displayName: 'OMP',
  modelListName: 'OMP',
  modelIdScope: 'provider-spanning',
  pickerLabel: 'OMP',
  pickerDescription: 'Oh My Pi CLI (provider/model)',
  icon: 'bot',
  installHint: 'https://omp.sh',
  loginCommand: 'omp login',
} as const satisfies RunnerDisplay;
