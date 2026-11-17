/* oxlint-disable cez/active-run-skills-write-outside-owner -- Compile proof deliberately attempts writes that TypeScript must reject. */
import type { ActiveRun } from '../../workflows/active-run.ts';
import type { SkillsGroup } from '../../workflows/run/run-skills.ts';
declare const state: ActiveRun;
declare const other: ActiveRun;
// @ts-expect-error The migrated slot is read-only.
state.skills = other.skills;
const { catalog } = state.skills;
// @ts-expect-error The array cannot be mutated.
catalog!.push(catalog![0]!);
// @ts-expect-error Numeric array slots cannot be replaced.
catalog![0] = other.skills.catalog![0]!;
// @ts-expect-error Listed skill properties are read-only.
catalog![0]!.path = 'forged';
// @ts-expect-error The session query is read-only.
state.skills.query!.accountHome = 'forged';
declare const group: Parameters<(group: SkillsGroup) => void>[0];
// @ts-expect-error A helper cannot replace the session query.
group.query = undefined;
