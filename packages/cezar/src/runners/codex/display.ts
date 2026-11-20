import type { RunnerDisplay } from '../../core/runner-definition.ts';

/** How the cockpit and server messages name the Codex runner (its `display` part). */
export const CODEX_DISPLAY = {
  displayName: 'Codex',
  modelListName: 'Codex',
  modelIdScope: 'own',
  pickerLabel: 'codex',
  pickerDescription: 'OpenAI Codex (app-server)',
  icon: 'sparkles',
  installHint: 'npm i -g @openai/codex',
  loginCommand: 'codex login',
  accountFolderExample: '~/.codex-second',
} as const satisfies RunnerDisplay;
