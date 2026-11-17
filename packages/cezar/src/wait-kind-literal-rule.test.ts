import { waitKindLiteral } from './lint/owner-reader-rules.ts';
import { ownerExceptions } from './lint/owner-rule.testkit.ts';

ownerExceptions(waitKindLiteral);
