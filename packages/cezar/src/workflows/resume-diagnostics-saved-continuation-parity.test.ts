import { sealTestRunners } from '../core/runner-registry.testkit.ts';
import '../runners/claude/claude-runner.testkit.ts';
import { registerResumeDiagnosticsGroup } from './resume-diagnostics.testkit.ts';
sealTestRunners();

registerResumeDiagnosticsGroup('saved-continuation');
