import { expect, it } from 'vitest';
import { BrowserSignInStartError, redactBrowserSignInDetails } from './browser-sign-in-error.ts';

it.each([
  'Authorization: Bearer private-credential',
  '{"refresh_token":"private-credential"}',
  'https://accounts.google.com/o/oauth2/auth?state=private-credential',
  'access_token=ya29.private-credential',
  "code: '4/0Aprivate-credential'",
  '{"code":"private-credential"}',
])('removes OAuth values from the public sign-in cause: %s', value => {
  const error = new BrowserSignInStartError(`initialize failed: ${value}`);
  expect(error.message).toContain('initialize failed:');
  expect(error.message).not.toMatch(/4\/0A|private-credential|https:/);
});

it.each(["code: 'EPIPE'", '{"code":"ENOENT"}', 'code=ERR_STREAM_DESTROYED', 'code: 1', 'code=-32'])('preserves native diagnostic fields: %s', value => {
  expect(redactBrowserSignInDetails(value)).toBe(value);
});
