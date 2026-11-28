import { parseAskRequest } from '@hearsay-tools/squawk/plugin/runtime';
import type { AskQuestion } from '@hearsay-tools/squawk/plugin';

export function toSquawkQuestions(value: unknown): AskQuestion[] | null {
  if (!isRecord(value) || !Array.isArray(value.questions)) return null;
  if (value.questions.length < 1 || value.questions.length > 4) return null;
  const questions: AskQuestion[] = [];
  for (const rawQuestion of value.questions) {
    if (!isRecord(rawQuestion)) return null;
    const header = clippedString(rawQuestion.header, 12);
    const question = clippedString(rawQuestion.question, 400);
    if (!header || !question || !Array.isArray(rawQuestion.options)) return null;
    const options: AskQuestion['options'] = [];
    for (const rawOption of rawQuestion.options) {
      if (options.length === 4) break;
      if (!isRecord(rawOption)) continue;
      const label = clippedString(rawOption.label, 60);
      if (!label) continue;
      const description = clippedString(rawOption.description, 280);
      options.push({ label, ...(description ? { description } : {}) });
    }
    if (options.length < 2) return null;
    questions.push({
      header,
      question,
      options,
      ...(rawQuestion.multiple === true ? { multiSelect: true } : {}),
    });
  }
  return parseAskRequest({ questions })?.questions ?? null;
}

const ADDITIONAL_COMMENTS_MARKER = '\n\nAdditional comments:\n';

export function questionAnswers(questions: AskQuestion[], text: string): string[][] {
  const markerIndex = text.indexOf(ADDITIONAL_COMMENTS_MARKER);
  const structuredText = markerIndex >= 0 ? text.slice(0, markerIndex) : text;
  const comment = markerIndex >= 0 ? text.slice(markerIndex + ADDITIONAL_COMMENTS_MARKER.length).trim() : '';
  const answers = questions.map(() => [] as string[]);
  const matched = new Set<number>();
  let lastMatched = -1;
  for (const line of structuredText.split(/\r?\n/)) {
    const trimmed = line.trim();
    const index = questions.findIndex(
      (question, questionIndex) =>
        !matched.has(questionIndex) && trimmed.startsWith(`${question.header}:`),
    );
    if (index < 0) continue;
    matched.add(index);
    lastMatched = index;
    answers[index] = trimmed
      .slice(questions[index]!.header.length + 1)
      .split(',')
      .map((answer) => answer.trim())
      .filter(Boolean);
  }
  if (matched.size === 0 && answers[0]) answers[0] = [text.trim()];
  else if (comment && lastMatched >= 0) answers[lastMatched]!.push(`Additional comments:\n${comment}`);
  return answers;
}

function clippedString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
