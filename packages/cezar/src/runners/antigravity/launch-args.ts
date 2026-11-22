/** The CLI's own app data folder name, so the default account shares the terminal CLI's skills and sign-in. */
export const ANTIGRAVITY_APP_DATA_DIR = 'antigravity-cli';

/** The CLI ignores GEMINI_HOME: the account folder is passed by flag, and the app data folder must be relative. */
export function antigravityLaunchArgs(geminiDir: string, extra: readonly string[] = []): string[] {
  return ['acp', '--gemini-dir', geminiDir, '--app-data-dir', ANTIGRAVITY_APP_DATA_DIR, ...extra];
}
