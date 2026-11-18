# Worker admission and settlement observations
Status: active

Scope: hearsay-tools/squawk#3901. Keep admission, process ownership and destroy
behavior. Clarify refusal text and unify list, inspect and collect settlement.
The coordinator approved an explicit `settled` field on inspect.

| State or sequence | Expected result | Preserved guarantee |
| --- | --- | --- |
| Settled session; detached service remains in worker scope | Continue accepted; service stays alive | Only recorded sessions and another controller block admission |
| Another live recorded controller | Refuse; name controller PID and executable; give next step | Controller ownership |
| Live previous recorded session | Refuse; name session PID and executable; give next step | No overlapping session execution |
| Unreadable ownership proof | Refuse with retry or new-worker next step | No unproven resource reuse |
| Terminal public status; private execution still starting | All observations unsettled | Public status alone is not termination proof |
| Private completion arrives during collect evidence read | Collect, inspect and list agree at the same revision | Read final settlement after asynchronous evidence reads |
| Continue changes revision during collect | Reject collection | Existing consistency and revision checks |
| Destroy requested while worker runs | Request stop; wait up to 30 seconds for termination; stop scope; remove worktree | No removal before termination proof |
| Worker fails before its first step | Existing automatic release still applies | No slot leak |
