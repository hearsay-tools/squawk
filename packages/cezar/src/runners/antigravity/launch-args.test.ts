import { expect, it } from 'vitest';
import { antigravityLaunchArgs } from './launch-args.ts';

it('launches the CLI ACP server on the account folder with a relative app data folder', () => {
  expect(antigravityLaunchArgs('/accounts/work')).toEqual(['acp', '--gemini-dir', '/accounts/work', '--app-data-dir', 'antigravity-cli']);
  expect(antigravityLaunchArgs('/accounts/work', ['--login'])).toEqual(['acp', '--gemini-dir', '/accounts/work', '--app-data-dir', 'antigravity-cli', '--login']);
});
