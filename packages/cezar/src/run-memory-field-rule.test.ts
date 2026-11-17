import { runMemoryField } from './lint/owner-state-rules.ts';
import { ownerExceptions } from './lint/owner-rule.testkit.ts';

ownerExceptions(runMemoryField);
