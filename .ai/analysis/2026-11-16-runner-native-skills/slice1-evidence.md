# Slice 1: list adapter evidence

2026-11-16. No model calls. Run one runner at a time from the repo root:

```
node --import tsx .ai/analysis/2026-11-16-runner-native-skills/slice1-probe.mjs <runner>
```

The script creates a scratch git repo directly under `/tmp`, adds metadata fixtures in the
native project folders, calls the actual adapter and prints metadata only. It removes the repo
after the adapter has killed and reaped its owned process. Account credentials are not read by
the driver. Native CLIs retain their own normal state writes.

| Runner / installed version | Measured list call | Result |
| --- | --- | --- |
| Claude Code 2.1.321 | 389 ms | live, 36 skills, no problems |
| Codex 0.164.0 | 364 ms | live, 39 skills, no problems |
| OpenCode 1.19.4 | 1149 ms | live, 25 skills after `.trash` filtering, no problems |
| pi 1.4.0 | 941 ms | live, 30 skills, no problems |
| omp 18.13.1 | 271 ms | live, 28 skills, 15 native warnings mapped to problems |

All calls returned `probe-project` with scope `repo`, a user skill, and plugin metadata.
Claude, Codex and omp output excerpts and the four open checks are in their reports. The
managed-hook limitation is explicit in `claude.md`.

OpenCode (trimmed):

```json
{"runner":"opencode","source":"live","skills":[{"id":"probe-project","name":"probe-project","description":"Project fixture.","path":"<repo>/.claude/skills/probe-project/SKILL.md","scope":"repo"},{"id":"setup-verification-maintenance","name":"setup-verification-maintenance","path":"<home>/.cache/opencode/packages/.../plugins/apptension-sdlc/skills/setup-verification-maintenance/SKILL.md","scope":"user","plugin":"apptension-sdlc"}],"problems":[]}
```

pi (trimmed):

```json
{"runner":"pi","source":"live","skills":[{"id":"probe-project","name":"probe-project","description":"Project fixture.","path":"<repo>/.pi/skills/probe-project/SKILL.md","scope":"repo"},{"id":"capture","name":"capture","path":"<home>/.agents/skills/capture/SKILL.md","scope":"user"},{"id":"cezar-cockpit","name":"cezar-cockpit","path":"<home>/.pi/agent/git/.../skills/cezar-cockpit/SKILL.md","scope":"user","plugin":"apptension-dev"}],"problems":[]}
```

## Native captures and offline proof

`packages/cezar/src/core/__fixtures__/<runner>/skill-list.json` holds excerpts of native
responses captured before the mock routes were added. Scratch root and home paths were
replaced with fixed paths. Only representative metadata entries remain. OpenCode's `content`
field was removed; no captured skill body or account response is committed.
`packages/cezar/scripts/mock-skill-list-data.mjs` mirrors these excerpts so packaged dry-run
mocks work without a source checkout. Each mock answers only its own native list route.

- Per-adapter unit tests parse the recorded response and reject malformed lists.
- `runner-skills-parity.test.ts` is one `every-runner` family selected by `parityRunners`.
  Each cell uses that runner's `HARNESS_ADAPTERS.mockBin`, asserts repo/user/plugin metadata,
  and checks Codex errors or omp warnings where the runner reports them.
- `skill-probe.test.ts` drives each adapter against a crashed process and a hung process
  that ignores TERM. It requires `unavailable`, a reason and observed process exit.
- `runner-skill-catalog.test.ts` checks concurrent joins, per-folder/account/runner keys,
  invalidation races, expiry, timeout cancellation and retained last-good lists.

No existing shared name or default is changed. The parity family and mock request handlers
are additive. No runner facts or session adapters change. The registry gets a `runner` layer
entry, and the contract gets its mandatory api-client re-export shim.
A source search for `hostSkillCatalogAdapters` and `RunnerSkillCatalog` finds only these new
catalog modules, their tests and the analysis probe. There is no route, cockpit reader or
prompt reader. Existing shipped behavior is unchanged.
