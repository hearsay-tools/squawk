import { expect, it } from 'vitest';
import { antigravityLaunchArgs } from './launch-args.ts';

it.each([
  ['linux', ['--uid=']], ['darwin', []], ['win32', []],
] as const)('uses the registry launch arguments on %s', (platform, args) => {
  expect(antigravityLaunchArgs(platform, {})).toEqual(args);
});

it.each(['linux', 'darwin', 'win32'] as const)('enables native debug logging only on opt-in (%s)', platform => {
  const defaults = antigravityLaunchArgs(platform, {});
  expect(antigravityLaunchArgs(platform, { HSQ_ANTIGRAVITY_DEBUG: '1' })).toEqual([...defaults, '--debug']);
  expect(antigravityLaunchArgs(platform, { CEZ_ANTIGRAVITY_DEBUG: '1' })).toEqual([...defaults, '--debug']);
  expect(antigravityLaunchArgs(platform, { HSQ_ANTIGRAVITY_DEBUG: '0', CEZ_ANTIGRAVITY_DEBUG: '1' })).toEqual(defaults);
});
