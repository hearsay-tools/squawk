import './every-runner.testkit.ts';
import { registerShutdownGroup } from './runner-shutdown.testkit.ts';

registerShutdownGroup('signal-readiness');
