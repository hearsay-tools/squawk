import { expect, it } from 'vitest';
import { antigravityLaunchArgs } from './launch-args.ts';

it.each([
  ['linux', ['--uid=']], ['darwin', []], ['win32', []],
] as const)('uses the registry launch arguments on %s', (platform, args) => {
  expect(antigravityLaunchArgs(platform)).toEqual(args);
});
