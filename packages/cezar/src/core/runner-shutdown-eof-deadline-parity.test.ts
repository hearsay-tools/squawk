import { registerShutdownGroup } from './runner-shutdown.testkit.ts';
import { registerRunner } from './runner-registry.ts';
import { claudeRunner } from '../runners/claude/definition.ts';
import { codexRunner } from '../runners/codex/definition.ts';
import { piRunner } from '../runners/pi/definition.ts';
import './created-runners.testkit.ts';
registerRunner(claudeRunner);
registerRunner(codexRunner);
registerRunner(piRunner);

registerShutdownGroup('eof-deadline');
