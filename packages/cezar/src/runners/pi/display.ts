import type { RunnerDisplay } from '../../core/runner-definition.ts';

/** How the cockpit and server messages name the Pi runner (its `display` part). */
export const PI_DISPLAY = {
  displayName: 'pi',
  modelListName: 'Pi',
  modelIdScope: 'provider-spanning',
  pickerLabel: 'pi',
  pickerDescription: 'pi CLI (provider/model)',
  icon: 'bot',
  installHint: 'https://github.com/badlogic/pi-mono',
  loginCommand: 'pi /login',
  accountFolderExample: '~/.pi-second/agent',
} as const satisfies RunnerDisplay;
