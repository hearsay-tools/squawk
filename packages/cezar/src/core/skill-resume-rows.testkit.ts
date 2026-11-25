import { BUILT_IN_RUNNER_IDS } from './built-in-runner-ids.testkit.ts';
import { expect } from 'vitest';
import { collectedOnly, partitionParity, type CellBody, type ParityPart, type ParityCollector } from './parity-partition.testkit.ts';
import { SKILL_RESUME_CRITERIA } from './harness-parity-core.testkit.ts';
import { factsWhere } from './runner-fact-rows.testkit.ts';

// The skill-resume cells and their partition, apart from the engine the cell bodies drive,
// so the registration guard collects the same names without loading it.
export const IN_THREAD = new Set(factsWhere(facts => facts.systemPromptOnResume === 'in-thread'));

const PARTS: Readonly<Record<string, readonly string[]>> = {
  "live-continue-claude-pi": [
    "claude R53",
    "claude R55",
    "pi R53",
    "pi R55"
  ],
  "live-continue-codex-omp": [
    "codex R53",
    "codex R55",
    "omp R53",
    "omp R55"
  ],
  "live-continue-opencode": [
    "opencode R53",
    "opencode R55"
  ],
  "recovery-prompt": [
    "claude R54",
    "codex R54",
    "omp R54",
    "opencode R54",
    "pi R54"
  ],
  "recovery-before-session-event": [
    "claude R59",
    "codex R59",
    "omp R59",
    "opencode R59",
    "pi R59"
  ],
  "session-identity-claude-pi": [
    "claude R57",
    "pi R57"
  ],
  "session-identity-codex-omp": [
    "codex R57",
    "omp R57"
  ],
  "session-identity-opencode": [
    "opencode R57"
  ],
  "wire-and-fallback": [
    "claude R56",
    "codex R56",
    "every runner declares systemPromptOnResume",
    "omp R56",
    "opencode R56",
    "pi R56"
  ],
  "wire-and-fallback-engine": [
    "codex fresh-session continuation includes the skill",
    "opencode fresh-session continuation includes the skill",
    "opens a fresh session with the skill, one note, and a new session id"
  ]
};

type RunnerCell = (backend: string) => CellBody;
export type SkillResumeCells = {
  resumedContinue: RunnerCell; recoveredContinuation: RunnerCell; recordedSession: RunnerCell;
  interruptedContinue: RunnerCell; skillGone: RunnerCell; freshSession: RunnerCell;
  declaresResumeMode: CellBody; declarationWire: RunnerCell; lostSession: CellBody;
};

export function skillResumeParity(cells: SkillResumeCells) {
  return function describeSkillResumeParity(part: ParityPart, collect?: ParityCollector): void {
    const { describe, it } = partitionParity(part, PARTS, collect, 'skill-resume');
    describe('harness parity — native skill on Continue (#790)', () => {
      expect(SKILL_RESUME_CRITERIA.map((row) => row.id)).toEqual(['R53', 'R54', 'R55', 'R56', 'R57', 'R59']);

      for (const backend of BUILT_IN_RUNNER_IDS) {
        it(`${backend} R53 does not retrigger a skill on a resumed Continue`, cells.resumedContinue(backend), 60_000);
        it(`${backend} R54 does not retrigger a skill when recover() resumes a persisted continuation`, cells.recoveredContinuation(backend), 60_000);
        it(`${backend} R57 reuses the recorded session id on Continue and recover`, cells.recordedSession(backend), 90_000);
        it(`${backend} R59 recovers a Continue interrupted before its session event`, cells.interruptedContinue(backend), 90_000);
        it(`${backend} R55 fails before a model call when the selected skill is gone`, cells.skillGone(backend), 60_000);
      }

      for (const backend of IN_THREAD) {
        it(`${backend} fresh-session continuation includes the skill`, cells.freshSession(backend), 60_000);
      }
    });

    describe('harness parity — systemPromptOnResume declaration (#790)', () => {
      it('every runner declares systemPromptOnResume', cells.declaresResumeMode);

      for (const backend of BUILT_IN_RUNNER_IDS) {
        it(`${backend} R56 declaration matches the resume wire`, cells.declarationWire(backend), 45_000);
      }
    });

    describe('opencode lost-session fallback (#790)', () => {
      it('opens a fresh session with the skill, one note, and a new session id', cells.lostSession, 60_000);
    });
  };
}

/** The same cells by name only, for the registration guard. */
export const skillResumeCellNames = skillResumeParity({
  resumedContinue: collectedOnly, recoveredContinuation: collectedOnly, recordedSession: collectedOnly,
  interruptedContinue: collectedOnly, skillGone: collectedOnly, freshSession: collectedOnly,
  declaresResumeMode: collectedOnly(), declarationWire: collectedOnly, lostSession: collectedOnly(),
});
