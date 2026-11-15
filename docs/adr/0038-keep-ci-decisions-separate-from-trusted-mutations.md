# Separate CI model decisions from trusted mutations

Untrusted issue and PR content is input to automation, not authority to change other objects.
CI decision producers return bounded structured output. Trusted applicators validate it and
own GitHub mutations. Publishing decisions resolve repository facts from GitHub rather than
trusting an uploaded artifact’s metadata.

## Consequences

Model calls receive only their required credentials and tools. Intake choices are bounded by
the prefetched candidate set; a decision engine cannot invent another target. CI runs no automated reviewer
(2026-11-15); the CodeRabbit admission of 2026-11-02 is removed. Merge-queue admission
refuses drafts and any unresolved review thread, and requires the newest native
`pull_request_target` run on the PR head to have passed the `verify` aggregate.
Heavy verification runs beside typecheck and preflight once its skip inputs
are ready. The `verify` aggregate requires all of them (2026-11-12,
hearsay-tools/cezarion#3342, replacing the preflight ordering of hearsay-tools/cezarion#2727),
and queue admission in a merge group. A default-branch workflow syncs the board and makes
no repository write; a PR-context review signal grants no authority.

This separation constrains what a model or artifact can request; it does not make arbitrary
same-user shell access an isolation boundary. Keep workflow permission and timing comments
beside their declarations.

Implementation: [jev-issue-intake.cjs](../../.github/scripts/jev-issue-intake.cjs), [apply-issue-intake.cjs](../../.github/scripts/apply-issue-intake.cjs), [pr-snapshot.cjs](../../.github/scripts/pr-snapshot.cjs), [merge-queue-admission.cjs](../../.github/scripts/merge-queue-admission.cjs), [pr-readiness.cjs](../../.github/scripts/pr-readiness.cjs), [issue-intake.yml](../../.github/workflows/issue-intake.yml), [pr-readiness.yml](../../.github/workflows/pr-readiness.yml).

Coverage: [jev-issue-intake.test.cjs](../../.github/scripts/jev-issue-intake.test.cjs), [apply-issue-intake.test.cjs](../../.github/scripts/apply-issue-intake.test.cjs).
