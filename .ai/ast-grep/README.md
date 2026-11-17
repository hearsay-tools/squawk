# ast-grep rules

Rules that pin a construction site or a reader of a shared thing, so a test finds what an agent
would otherwise have to find by hand (hearsay-tools/cezarion#1802). A rule matches a syntax tree,
not text: it sees an `ActiveRun` literal whatever order its fields take, which the regex
scans over `blank()` and a clone detector miss. It knows no types and resolves no imports, so it
matches names (`state`, `active`), and a rule says in a comment what it leaves out.

Ast-grep rules match syntax shapes, not data flow. Local normalization and lexical
patterns cover only the forms a rule declares; they do not provide general binding or
type resolution. For a new safety guard, follow [New safety guards](../../docs/sdlc/lint.md#new-safety-guards):
prefer a compiler/language boundary, otherwise ban named syntax with a reasoned annotation
escape. State static scope first; track values only when the rule's issue asks for it.
Review rule-coverage findings against that scope.

`npm run lint` scans the repository with every rule and fails a match beyond the baseline, in CI's
required Lint step and, through the bridge tests `packages/cezar/src/lint/lint-ast-grep-{1,2}.test.ts`, in Squeal.
The failure carries the rule's `message`, which names the owner to use instead.
`packages/cezar/src/ast-grep-rules.test.ts` runs each rule's own cases. [The lint guide](../../docs/sdlc/lint.md)
covers every repository rule.

These rules are moving into AST rules of the `cez` oxlint plugin (hearsay-tools/squawk#3774).
Add no new ast-grep rule: write an AST rule, as [Add a rule](../../docs/sdlc/lint.md#add-a-rule) says.
A ported rule's `rules/` and `rule-tests/` files are deleted in the PR that adds its replacement.

## What each rule has

| File | Holds |
| --- | --- |
| `rules/<id>.yml` | The rule. `id` is the file name, `severity` is `warning` (the scan exits 0 and `npm run lint` judges the matches), `files` limits it to the files it is about, and `message` names the owner to use instead, with repository-qualified citations |
| `rules/<id>.baseline.json` | The matches the rule carried when it landed. **One baseline file per rule**, never a shared file, so rules land in parallel. It only shrinks; a rule with no baseline file allows no match |
| `rule-tests/<id>-test.yml` | **A rule-tests file for each rule**: `valid` snippets the rule must leave alone and `invalid` ones it must report. The test fails for a rule without one, because a rule that matches nothing (a renamed type, a typo) looks like a clean repository |

`sgconfig.yml` at the repo root names both directories.

## Launch-read normalization and generated cases

The launch-read family now runs as `cez/launch-read-outside-resolver` in oxlint
(hearsay-tools/squawk#3774). Its binding and type helpers live in
`packages/cezar/src/lint/launch-read/`. See [the lint guide](../../docs/sdlc/lint.md#launch-read-ownership)
for its scope and limits. The three `launch-read-matrix*.test.ts` files evaluate
the in-memory corpus in `lint/launch-read/matrix.cjs` through oxlint's RuleTester.
They retain all invalid cells, unrelated controls and 3456 documented-limit cells.
Curated cases from the eleven former YAML rules live in `lint/launch-read/cases.json`.

## Add a rule

1. Write `rules/<id>.yml` and `rule-tests/<id>-test.yml`, and run
   `./node_modules/.bin/ast-grep test --skip-snapshot-tests` until they pass.
2. Count its matches: `./node_modules/.bin/ast-grep scan --config sgconfig.yml --filter '^<id>$'`.
3. Write its first baseline with `AST_GREP_RULES_UPDATE=1 npm run lint`.
   Update mode writes the baseline of a rule that has none and otherwise only lowers one.
4. A PR that fixes a match runs the same command to shrink the baseline. The CI check from
   hearsay-tools/cezarion#1799 refuses a baseline that grows.

A baseline entry is keyed by file and the first line of the match, so a moved line does not churn
it; editing that line makes the match new. That is deliberate: edit it by moving it to its owner.

## Traps

- A pattern that starts with `{` parses as a block. Name the statement as `context` and the node
  as `selector`.
- `$$$` after a comma does not match zero arguments. Write the one-argument pattern and the
  many-argument pattern.
- Relational rules (`has`, `inside`) share metavariables with their `all` siblings. That is how
  `cez/server-declared-validator-schema` ties a call's argument to a declaration in the same file.
  Its replacement is `cez/server-declared-validator-schema`, with a Program binding pass.
- Start from the rare node. The same rule started from every `const` in `server.ts` and searched
  the file for a call: 11 s. Started from the 106 validator calls: 1 s.
- Every branch of a rule needs a `kind`, a `pattern` or an `any` of those, or the rule fails to load.
- `ast-grep` counts lines from 0. The scan adds 1.
- A rule parses `.ts` files with one grammar and `.tsx` files with another, and a `language` takes
  one. A rule over both is two rule files with the same body: `test-enum-literal.yml` and
  `test-enum-literal-tsx.yml`, which `test-enum-literal-rule.test.ts` holds equal.
- `// ast-grep-ignore: <rule id>` suppresses a match, but only from the line directly above it. A
  line comment that explains it goes above that one, and the id of a `-tsx` twin is its own.

## The binary

`@ast-grep/cli` is pinned to an exact version. `pnpm-workspace.yaml` denies its postinstall, so
`node_modules/.bin/ast-grep` is a JS shim that prints a warning on stderr and starts the platform
binary. The lint runner reads stdout only and finds the binary through the package's own resolver. A
host with no platform binary (musl, or `--no-optional`) fails lint with the package name,
never skips it. The scan reads local files only.

For local three-way baseline merges and driver setup, see
[Local ratchet baseline merges](../../docs/sdlc/ci.md#local-ratchet-baseline-merges).
