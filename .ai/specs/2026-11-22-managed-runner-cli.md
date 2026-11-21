# Managed runner CLI installation
Status: active

Implements hearsay-tools/squawk#4059. Runner launch integration belongs to
hearsay-tools/squawk#4060. The runner definition declares the manifest template,
download URL prefix and executable names. Boot only constructs the service.
Only a Settings request fetches a manifest. Status requests check at most hourly;
Check for updates and Update bypass that cache. A failed check keeps the active
release. No environment variables or required configuration are added.

Binaries live in `<data>/tools/<runner>/<target>/versions/<sha512-prefix>/`.
The data root follows `docs/migration.md`; managed binaries are disposable data,
separate from configuration and run state. A release contains only its executable
and completion record. `active.json` changes by atomic replacement after checksum,
safe extraction and a matching `--version` check. Sealed releases are read-only.
An update never modifies a published release. Google supplies no withdrawal feed;
this installer does not invent one. Remove deactivates immediately and prunes only
unleased releases. A future compatibility authority can deactivate a withdrawn
release through that same operation.

## Lock and ownership cases

| Path | Locks or claims taken, in order | Missing or unreadable owner |
| --- | --- | --- |
| Install/update/remove | Data-root short HomeStore lock → persisted per-target install claim; release short lock before network work. Activation and pruning retake the short lock. | Missing/dead process claim can be replaced under the short lock; malformed/unreadable claim refuses. A live process claim waits asynchronously with a four-minute bound. |
| Active executable read | No write or claim; atomic active record and sealed release read only | Missing active record returns no managed executable; malformed/unreadable active record refuses. |
| Acquire lease | Data-root short lock → read active → publish unique release lease | Missing active record returns no lease; malformed/unreadable record refuses. |
| Bind lease to child | Data-root short lock → replace lease owner with child PID and start identity | Binding a released lease refuses. The caller binds immediately after spawn. |
| Release lease | Data-root short lock → remove own unique lease → prune | Releasing twice is safe. Malformed/unreadable peer lease refuses pruning. |
| Prune | Existing short lock → read active and every persisted lease → remove unused releases | A live PID with unavailable start identity is retained conservatively. Dead owners lose their leases. No run-id gate applies; claims identify host processes. |

## Done when

- Outcome: Settings installs, updates and removes the CLI with progress and the browser sign-in permission gate.
- Proof: focused installer, API and UI tests; isolated live cockpit install of 1.5.14 and its version output.
- Failure: wrong sha512, unexpected archive entry and hosted installation without settingsAdmin are refused.
