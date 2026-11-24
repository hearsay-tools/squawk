import { FixtureAdapter } from './fixture-adapter.testkit.ts';
import { offerRunners, onlyRunner, RUNNER_OFFER } from '../../core/runners-under-test.testkit.ts';
import { fixtureRunner } from './definition.testkit.ts';

// Importing this module makes the fixture runner the test file's only runner. Use it for
// runner-agnostic engine parity tests so they load zero built-in adapters.
offerRunners(onlyRunner(fixtureRunner, () => new FixtureAdapter()), RUNNER_OFFER.fixture);
