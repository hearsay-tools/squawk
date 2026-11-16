---
name: check-code-quality
description: Measure complexity and CRAP for a requested JavaScript or TypeScript file, function or module, or check changed functions' complexity before a pull request opens.
---

# Check code quality

Choose the path from the current task:

| Request | Path |
| --- | --- |
| Get stats for a named file, function or module | Read [Measure requested code](references/measure.md). It uses Squeal |
| Check a PR's changed functions before you open it, or recheck them | Read [Before a PR](references/pre-pr.md). It runs the bundled complexity gate |

The split: the local pre-PR check is complexity only. CRAP needs coverage, so
CI reports it from the pull request's Vitest coverage and never fails a check
on it; functions over CRAP 30 are filed after the merge. A measurement ends
with the requested stats and any coverage limits; during PR work it does not
replace the pre-PR check.

The scripts in `scripts/` serve that gate and CI; read
[Bundled tool](references/tool.md) before you change them.
