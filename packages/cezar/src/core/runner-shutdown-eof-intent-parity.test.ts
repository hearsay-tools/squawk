import { sealTestRunners } from './runner-registry.testkit.ts';
import { registerShutdownGroup } from './runner-shutdown.testkit.ts';
import { claudeRunner } from '../runners/claude/definition.ts';
import { codexRunner } from '../runners/codex/definition.ts';
import { piRunner } from '../runners/pi/definition.ts';
import './created-runners.testkit.ts';

sealTestRunners(claudeRunner, codexRunner, piRunner);

registerShutdownGroup('eof-intent');
