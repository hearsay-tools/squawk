import type { RunnerDisplay } from '../../core/runner-definition.ts';
export const ANTIGRAVITY_DISPLAY = {
  displayName: 'Antigravity', modelListName: 'Antigravity', modelIdScope: 'own',
  pickerLabel: 'Antigravity', pickerDescription: 'Google Antigravity over ACP', icon: 'bot',
  installHint: 'https://antigravity.google', loginCommand: 'Use your Antigravity sign-in in ~/.gemini',
  accountFolderExample: '~/.gemini',
} as const satisfies RunnerDisplay;
