import { describeWorkflowTimeoutParity } from './workflow-timeout-parity.testkit.ts';
import { installWorkflowTimeoutEngine } from './workflow-timeout-engine.testkit.ts';

installWorkflowTimeoutEngine();
describeWorkflowTimeoutParity('defaults');
