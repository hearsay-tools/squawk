# Expose account details only on demand

**Withdrawn** on 2026-11-18 (hearsay-tools/squawk#3865): the details route and its readers were
removed, so no route answers account identity. This record describes the removed model. Its
implementation and coverage paths refer to that historical snapshot.

Showing an account email only after a click is insufficient if the normal listing already
contains it. Identity details therefore have a separate local-only route. Readers select named
fields from native files and construct a fresh response; they never forward the parsed credential
object.

## Consequences

Ordinary account listings and run persistence do not gain identity details. The details view
can report unavailable data without blocking account use. JWT claims are display input, not
verified authentication evidence. New vendor fields do not automatically enter the response;
adding one requires an explicit reader change.

Implementation: [account-identity.ts](../../packages/cezar/src/agent-config/account-identity.ts), [agent-profiles.ts](../../packages/contract/src/agent-profiles.ts).

Coverage: [account-identity.test.ts](../../packages/cezar/src/agent-config/account-identity.test.ts), [agent-profiles-api.test.ts](../../packages/cezar/src/server/agent-profiles-api.test.ts).
