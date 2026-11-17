/* oxlint-disable cez/run-internals -- The retired name and module path are rule fixtures. */
import { AST_RULES } from './plugin.ts';
import { ruleCases } from './ast-rule.testkit.ts';

// Every former ast-grep case, with its original source and diagnostic count (hearsay-tools/squawk#3774).

ruleCases(AST_RULES.find(rule => rule.name === "worktree-write-outside-manifest")!, {
  "file": "packages/cezar/src/skills-provision.ts",
  "valid": [
    "import { readFile, lstat } from 'node:fs/promises'",
    "import { existsSync, readFileSync } from 'node:fs'",
    "import type { Stats } from 'node:fs'",
    "import { writeFile } from './worktree-manifest.ts'",
    "import { join } from 'node:path'",
    "const path = await import('node:path')"
  ],
  "invalid": [
    "import { writeFile } from 'node:fs/promises'",
    "import { readFile, rm } from 'fs/promises'",
    "import { mkdirSync } from 'node:fs'",
    "import { promises } from 'node:fs'",
    "import { rename as move } from \"node:fs/promises\"",
    "import * as fs from 'node:fs'",
    "import fs from 'fs'",
    "const fs = await import('node:fs/promises')"
  ]
});
