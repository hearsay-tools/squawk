import { expect, it } from 'vitest';
import { profileArgs } from '../../scripts/profile-lint.ts';

// The profile tool's command line (hearsay-tools/squawk#3774): a wrong path silently measures another scope.
it.each([
  [['packages/web'], ['packages/web'], 1],
  [['packages/cezar', 'packages/web'], ['packages/cezar', 'packages/web'], 1],
  [['--runs', '3', 'packages/web'], ['packages/web'], 3],
  [['packages/web', '--runs', '2', '--alone'], ['packages/web'], 2],
  [['--alone'], ['packages'], 1],
])('reads %j as paths %j and %i runs', (args, paths, runs) => {
  expect(profileArgs(args)).toMatchObject({ paths, runs });
});

it('reads the --alone and --families flags', () => {
  expect(profileArgs(['--alone', '--families'])).toMatchObject({ alone: true, families: true });
  expect(profileArgs([])).toMatchObject({ alone: false, families: false });
});
