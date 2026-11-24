import { sealTestRunners } from '../core/runner-registry.testkit.ts';
import '../runners/fixture/fixture-runner.testkit.ts';
import { fixtureRunner } from '../runners/fixture/definition.testkit.ts';
import { registerResumeDiagnosticsGroup } from './resume-diagnostics.testkit.ts';

sealTestRunners(fixtureRunner);

registerResumeDiagnosticsGroup('human-text');
registerResumeDiagnosticsGroup('saved-continuation');
