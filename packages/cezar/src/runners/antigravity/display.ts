import type { RunnerDisplay } from '../../core/runner-definition.ts';
export const ANTIGRAVITY_DISPLAY = {
  displayName: 'Antigravity', modelListName: 'Antigravity', modelIdScope: 'own',
  pickerLabel: 'Antigravity', pickerDescription: 'Google Antigravity over ACP', icon: 'bot',
  installHint: 'https://antigravity.google', loginCommand: 'Set GEMINI_API_KEY or GOOGLE_API_KEY, or use your Antigravity sign-in in GEMINI_HOME (default ~/.gemini)',
  accountFolderExample: '~/.gemini',
} as const satisfies RunnerDisplay;
