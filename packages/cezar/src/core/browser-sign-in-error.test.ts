import { expect, it } from 'vitest';
import { BrowserSignInStartError } from './browser-sign-in-error.ts';

it.each([
  'Authorization: Bearer private-credential',
  '{"refresh_token":"private-credential"}',
  'https://accounts.google.com/o/oauth2/auth?state=private-credential',
  'access_token=ya29.private-credential',
])('removes OAuth values from the public sign-in cause: %s', value => {
  const error = new BrowserSignInStartError(`initialize failed: ${value}`);
  expect(error.message).toContain('initialize failed:');
  expect(error.message).not.toMatch(/private-credential|https:/);
});
