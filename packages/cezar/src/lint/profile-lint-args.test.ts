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

// `--compare` takes a value that is never a lint path (hearsay-tools/squawk#4238): before it, the
// value became a path, oxlint found no files and the tool still printed a CPU time.
it.each([
  [['--compare', 'origin/main'], ['packages'], 5],
  [['--compare', 'base.json', 'packages/web'], ['packages/web'], 5],
  [['packages/cezar', '--compare', 'origin/main', '--runs', '3'], ['packages/cezar'], 3],
])('reads %j as a compare against its value, paths %j and %i rounds', (args, paths, runs) => {
  expect(profileArgs(args)).toEqual({ paths, runs, alone: false, families: false, compare: args[args.indexOf('--compare') + 1] });
});

it('refuses --compare or --runs without a value', () => {
  expect(() => profileArgs(['--compare'])).toThrow('--compare needs a value');
  expect(() => profileArgs(['--compare', '--runs', '3'])).toThrow('--compare needs a value');
  expect(() => profileArgs(['--runs'])).toThrow('--runs needs a value');
});
