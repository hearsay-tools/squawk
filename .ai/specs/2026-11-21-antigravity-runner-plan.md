# Antigravity runner over shared ACP
Status: active

## Goal

Implement hearsay-tools/squawk#4002 using the live 1.5.0 wire evidence from
hearsay-tools/squawk#4000 and the shared ACP session. Accounts and live model discovery
remain hearsay-tools/squawk#4003. The coordinator lands the PR.

## Tool-list kinds

The runner resets saved modes to `default`. Native permission requests and client file reads
enforce grants. `ask_question`, `schedule`, and `finish` need no tool admission. There is no
separate grep/search tool in this version; shell searches use the Bash grant.

| Case | Native policy at shipped defaults | Client reads |
| --- | --- | --- |
| unset | Native permission card; native defaults | Allowed |
| step-default | Allow requested tools in default list; reject others | Read allowed |
| inherited | Allow inherited names; reject others | Only with Read |
| explicit-copy | Same as step-default | Read allowed |
| extra-built-in | Also allow the named built-in | Only with Read |
| extra-mcp | Also allow that server/tool name | Only with Read |
| narrowed | Allow named tools; reject others | Only with Read |
| empty | Reject permission requests | Refused |
| bash-allowlist | Allow matching command prefixes without shell composition; reject others | Only with Read |
| unset-bash-allowlist | Native defaults except restricted Bash prefixes | Allowed |

With `HSQ_APPROVAL_GATE=1`, an ungranted native request reaches the native permission card
instead of an automatic rejection. Granted requests remain automatic. Native interaction
questions always reach the question card. Client file reads cannot request interactive approval.

## Session and process cases

| Case | Behavior |
| --- | --- |
| Fresh task or continuation without a session | session/new, then opening prompt; fallback skill only on a fresh session |
| Continue or queued continuation after restart | session/resume; resend system prompt and reset mode; native error fails explicitly |
| Mixed-runner or mid-workflow Continue | Existing shared step/session selection supplies this runner's spec unchanged |
| Human Continue races automatic Continue | Existing shared admission chooses one; no new admission mechanism |
| Input while busy | A second session/prompt acknowledges steering without finishing the first prompt |
| Late steer after native completion | Track the outstanding prompt separately; no input may run without a normalized turn |
| Native ask idle-close | Cancel pending request; reopened session receives the answer as its first prompt |
| Normal close | Close ACP input and HTTP bridge; bounded SIGTERM then SIGKILL; await child close |
| Interrupt/deadline | Send session/cancel, then bounded process termination; deadline fails the task |
| Process exits early | Reject pending RPCs, drain bounded output, fail incomplete turn |
| Parent killed or handle removed | Existing owned process scope controls cleanup; no detached helper or durable handle |

## Shared behavior changes

Existing runners keep interactive CLI handoff by default. A definition with `cli.interactive=false`
has no terminal target, resume command, or terminal action. Direct handoff requests fail clearly.
The API derives `cliHandoff=false`; stored records are unchanged.

Skill-list parity retains native-wire assertions by default. A declared filesystem catalog lists
only confirmed project/user roots and asserts no invented plugin metadata. Tool-grant parity
retains argv assertions by default; permission-policy runners instead pin recorded native replies.
The scratch-runner simulation appends to the current roster, without naming its last runner.

## Live acceptance fixes

The follow-up fixes for hearsay-tools/squawk#4004 preserve native model ids, extract the
build label from the version banner, and send only the task checkout as an ACP workspace.
Lifecycle MCP tools load eagerly. Squawk disables native `run_workflow` on new and resume
because it owns workflows and the native tool writes a skill into the checkout. Native
`start_subagent` remains. Known command updates are silent; terminal turns close open tools.
Native option questions set `allowFreeText=false`; unsupported counts cancel visibly.

### Worktree cases

| Case | Files written, kept or removed | Next step, Continue and restart |
| --- | --- | --- |
| Native catalog not loaded | Native workflow tool disabled before session setup; no generated skill | Same filter sent on new and resume |
| User already owns skills/system/run-workflow | Leave the file unchanged; never delete or ignore it | User content remains visible to git |
| Same skill name from two sources | Existing native catalog precedence; this fix installs no skill | Existing catalog behavior remains |
| Old runner already wrote a generated skill | Do not remove existing content automatically | Existing tracked or untracked file stays user-owned |
| Crash during native startup | No Squawk skill writes or two-write transaction | Fresh session resends the filter |
| Source removes a user skill | No cleanup writer in this fix | Native catalog sees its current sources |
| Handoff or TMPDIR outside workspace | Shell writes to absolute task paths remain usable; proved live | Paths come from the resumed task spec |

### Process exits

| Case | What stops it | Behavior at shipped defaults |
| --- | --- | --- |
| Normal end | EOF, then existing TERM/KILL deadline | Snapshot descendants before EOF; reap observed detached children |
| Stop or timeout during a command | session/cancel, cancellation response or bounded grace, then EOF/TERM/KILL | Keep ACP open for failed tool updates; fail unfinished tool rows |
| Harness exits before command | Captured descendant identity, then TERM/KILL | Reparenting does not remove the captured identity |
| Member ignores TERM | Bounded KILL timer survives leader exit | Same process incarnation required before signalling |
| Parent command interrupted before spawn | Existing owned process scope | No child exists |
| Parent command interrupted after spawn | Existing owned process scope | This fix adds in-process Stop cleanup, not persistent containment |
| Parent killed with SIGKILL | Existing owned process scope | In-memory snapshots cannot run after owner death; no new guarantee |
| Missing or forged stop handle | No new durable handle; only observed descendants | Refuse unreadable or changed process identities; never signal an unrelated PID |
| Zombie, unreadable or reused identity | Ignore dead entries; compare live start identities | Skip an identity that cannot be proved |

Existing Continue admission, workflow cursors and run exit triggers remain unchanged. The
only session-resume changes are resending the workflow filter and eager MCP server name.

Explicit shutdown parity (S27/S28/S30) reads `shutdownDescendants`: Antigravity declares `observed-tree` and must kill the detached fixture as well as its process group; other runners declare `process-group` and retain their original detached-survivor assertion. S30 calls end and captures before EOF; S31 abrupt external exit remains unchanged because no pre-shutdown snapshot is guaranteed.
