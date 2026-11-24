import { sealTestRunners } from '../core/runner-registry.testkit.ts';
import '../runners/fixture/fixture-runner.testkit.ts';
import { fixtureRunner } from '../runners/fixture/definition.testkit.ts';
import { describeSessionContext, SESSION_CONTEXT_GROUPS } from './session-context-cells.testkit.ts';

sealTestRunners(fixtureRunner);

describeSessionContext(SESSION_CONTEXT_GROUPS.opening);
describeSessionContext(SESSION_CONTEXT_GROUPS.live);
describeSessionContext(SESSION_CONTEXT_GROUPS.retry);
describeSessionContext(SESSION_CONTEXT_GROUPS.recovery);
describeSessionContext(SESSION_CONTEXT_GROUPS.worker);
