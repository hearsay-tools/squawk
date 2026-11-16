# Slice R: native links for this repository's skills

Evidence for hearsay-tools/squawk#3749, recorded 2026-11-16. Canonical files stay in
`.ai/skills/`. Five relative directory links in each of `.agents/skills/` and
`.claude/skills/` point to `../../.ai/skills/<name>`. No runner required moving files.

## Scratch link checks, before implementation

Scratch git repository: `/tmp/slice-r-symlink.0XAGMB`. Its fixture was
`.ai/skills/slice-r-linked/SKILL.md`, with `name` and `description` frontmatter and
body `Reply with exactly SLICE-R-LINK-OK. Do not use tools.` Both native folders
linked to that canonical folder, with the same relative link layout as the patch.
One runner process ran at a time. Each child PID was stopped after its check.

| Runner | Version | Linked fixture listed | Start evidence |
| --- | --- | --- | --- |
| Claude | 2.1.321 | `get_skills_dialog`: `slice-r-linked` | `/slice-r-linked` replay contains `<command-name>/slice-r-linked</command-name>`; runner expansion, with hooks disabled and no session persistence |
| Codex | 0.164.0 | `skills/list`: `slice-r-linked`, resolved `.ai/skills/slice-r-linked/SKILL.md` | Existing [Codex probe](codex.md), Name rules: linked skill listed with resolved path and `$probe-linked` injects its body; no repeated model turn |
| OpenCode | 1.19.4 | `GET /skill`: `slice-r-linked` at `.agents/skills/slice-r-linked/SKILL.md` | `GET /command` gives `name: slice-r-linked`, `source: skill`, and the full marker body plus `Base directory for this skill: .../.agents/skills/slice-r-linked`; the [probe](opencode.md) proves this command route starts that expanded template |
| pi | 1.4.0 | RPC `get_commands`: `skill:slice-r-linked`, `.agents/skills/slice-r-linked/SKILL.md` | `/skill:slice-r-linked` becomes user content `<skill name="slice-r-linked" location=".../.agents/skills/slice-r-linked/SKILL.md">...SLICE-R-LINK-OK...</skill>` |
| omp | 18.13.1 | `omp skill list --json`: `slice-r-linked`, `.claude/skills/slice-r-linked/SKILL.md` | `/skill:slice-r-linked` emits `message_start`, role `custom`, `customType: skill-prompt`, with the marker body and linked skill directory |

Claude and omp were stopped at the expansion signal. Two initial pi captures used
a predicate that compared escaped JSON with unescaped quotes and missed the signal;
those benign turns completed before the driver was corrected. The corrected capture
stopped at the expanded user message. No production skill was invoked.

## Fresh worktree lists

Created with `git worktree add -b probe/slice-r-bb428373 /tmp/slice-r-fresh-bb428373 HEAD`,
then fast-forwarded to implementation fix `2e88481004ea66fa1d4de1e386c1ced5e258b5b8`.
The initial five lists ran before dependency installation, any worktree setup
hook, skill copying, or provisioning. All five lists were repeated after the
ignore-rule fix and cleanup of the provisioning proof. The links came from Git alone.

| Runner | No-model list route | Listed repository skills |
| --- | --- | --- |
| Claude | stream JSON control request `get_skills_dialog` | `auto-merge`, `campaign`, `check-code-quality`, `land-pr`, `om-prepare-test-env` |
| Codex | app-server `initialize`, `initialized`, `skills/list {cwds:[<worktree>]}` | `auto-merge`, `campaign`, `check-code-quality`, `land-pr`, `om-prepare-test-env` |
| OpenCode | `opencode debug skill`, stdout redirected to a file | `auto-merge`, `campaign`, `check-code-quality`, `land-pr`, `om-prepare-test-env` |
| pi | RPC `get_commands` with Squawk's extensions and default tools | `skill:auto-merge`, `skill:campaign`, `skill:check-code-quality`, `skill:land-pr`, `skill:om-prepare-test-env` |
| omp | `omp skill list --json` | `auto-merge`, `campaign`, `check-code-quality`, `land-pr`, `om-prepare-test-env` |

Every list reported zero missing expected skills. Codex returned canonical
`.ai/skills/<name>/SKILL.md` paths. OpenCode and pi returned
`.agents/skills/<name>/SKILL.md`. omp returned `.claude/skills/<name>/SKILL.md`.
Claude's control response has names and sources, without paths.

Claude launch: `--input-format stream-json --output-format stream-json --verbose
--replay-user-messages --settings '{"disableAllHooks":true}' --no-session-persistence
--permission-mode dontAsk --model haiku`. List request:
`{"type":"control_request","request_id":"list","request":{"subtype":"get_skills_dialog"}}`.

pi launch: `--mode rpc --no-session --extension <repo>/packages/cezar/scripts/pi-retry-degraded-service.mjs
--extension <repo>/packages/cezar/scripts/pi-project-skills.mjs --model zai/glm-5.3-flash
--no-builtin-tools --extension <repo>/packages/cezar/scripts/pi-default-tools.mjs
--cezar-builtin-tools read,edit,write,grep,find,bash`. List request:
`{"id":"list","type":"get_commands"}`. These are Squawk's default tool and project
skill flags; no trust override was needed.

OpenCode's first piped CLI capture truncated JSON, as its existing probe warns.
Direct file output produced complete JSON and the five names above.

## Guard test and red evidence

`.github/scripts/repository-skill-links.test.cjs` compares each tracked mirror set
with the directories under `.ai/skills/`. It checks each entry is a relative
symlink with the exact target, the resolved directory matches, and `SKILL.md`
exists. Untracked installs and provisioning files do not enter the tracked set.

The existing `test:unit:scripts` glob `.github/scripts/*.test.cjs` selects the test.
CI's `Unit tests (scripts)` matrix job runs that script. Squeal's existing node:test
include selects it too; its new input entry covers the canonical folders, links,
and root ignore rules. No workflow change was needed.

Both mutations used `squeal run tests .github/scripts/repository-skill-links.test.cjs
--wait 60000`, followed by `squeal why '<check>' --include-logs` to read the verdict:

| Mutation | Squeal evidence | Result |
| --- | --- | --- |
| Add `.ai/skills/slice-r-missing/SKILL.md`, without mirror links | Revision 3, run `8c7697fb-bdcf-4985-8207-b3f197b6454d` | Both tests fail: expected set includes `slice-r-missing`, actual tracked sets omit it |
| Remove that fixture; stage dangling `.agents/skills/slice-r-orphan` | Revision 5, run `384a81e6-5a0b-4cc1-8c15-83de6834dc67` | `.agents` test fails: actual set includes `slice-r-orphan`, canonical set omits it |

Both temporary mutations were removed before committing. The final green verdict
and local gates are recorded in the PR body.

## Ignore behavior and provisioning

`git check-ignore -v` after the scope fix:

```text
.gitignore:31:.agents/                  packages/web/.agents/skills/x/SKILL.md
.gitignore:35:/.agents/skills/*         .agents/skills/new-skill/SKILL.md
.gitignore:33:/.agents/*                .agents/other
```

`git ls-files .agents` lists exactly the five tracked links. A real untracked
sample `.agents/skills/slice-r-installed-sample/SKILL.md` also matched
`/.agents/skills/*`; `git status --porcelain --untracked-files=all` remained empty.
The sample was removed. Thus package-local `npx skills` installs stay ignored too.

A direct invocation of today's `provisionSkills` from `packages/cezar/src/skills-provision.ts`
ran in the fresh linked worktree, using a scratch home under `/tmp`:

1. Provision the five canonical skills: `installed: []`, all ten link strings
   unchanged, git status clean.
2. Provision those five plus a generated `slice-r-provisioned` skill:
   `installed: ["slice-r-provisioned"]`, all ten links unchanged, git status clean.
   Both native folders received this generated `.gitignore`:

   ```text
   # cezar: skills installed for this task, not part of the repository
   /.gitignore
   /slice-r-provisioned
   ```

The source explains the result: `provisionPass` plans ignore entries only for
recorded or absent paths; `claimPath` skips present, unrecorded paths (`theirs`).
The generated ignore file names only the provisioned entry. It does not hide the
tracked links. `removeProvisionedSkills` cleaned its generated files afterwards.
No Squawk source changed.

## Existing path and body preservation

A baseline-tree check enumerated all 32 tracked files below `.ai/skills/` at
`fd1e7f658e09e65b2550dcf655a5934c1ffdbca6`. Every file still resolves. Every byte is
unchanged except the four frontmatter lines added to `om-prepare-test-env/SKILL.md`;
stripping that added frontmatter yields its original body byte for byte. Existing
references keep their targets. Squawk's discovery code remains unchanged.

The coordinator will repeat the five lists on main after landing. Probe processes
and scratch worktrees are removed after capture; no user configuration or
credentials were copied.
