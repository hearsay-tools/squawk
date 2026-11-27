import { parseAskRequest } from '@hearsay-tools/squawk/plugin/runtime';
import type { AskQuestion } from '@hearsay-tools/squawk/plugin';
import { stringField } from './codex-native-frames.ts';

export function codexAskQuestions(value: unknown): AskQuestion[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) return null;
  const questions: unknown[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const question = raw as Record<string, unknown>;
    if (question.isSecret === true) return null;
    const id = stringField(question, 'id');
    const header = stringField(question, 'header');
    const prompt = stringField(question, 'question');
    if (!id || !header || !prompt || !Array.isArray(question.options)) return null;
    const options = question.options.map((option) => {
      if (!option || typeof option !== 'object' || Array.isArray(option)) return null;
      const record = option as Record<string, unknown>;
      const label = stringField(record, 'label');
      const description = stringField(record, 'description');
      return label ? { label, ...(description ? { description } : {}) } : null;
    }).filter((option): option is { label: string; description?: string } => option !== null);
    questions.push({ id, header, question: prompt, options, multiSelect: false });
  }
  return parseAskRequest({ questions })?.questions ?? null;
}

export function userInputAnswers(questions: AskQuestion[], text: string): Record<string, { answers: string[] }> {
  const marker = '\n\nAdditional comments:\n';
  const markerIndex = text.indexOf(marker);
  const body = markerIndex >= 0 ? text.slice(0, markerIndex) : text;
  const comment = markerIndex >= 0 ? text.slice(markerIndex + marker.length).trim() : '';
  const lines = body.split(/\r?\n/);
  const hasStructuredAnswer = questions.some((question) => lines.some((line) => line.startsWith(`${question.header}:`)));
  const answers: Record<string, { answers: string[] }> = {};
  let lastAnsweredKey: string | undefined;
  for (const [index, question] of questions.entries()) {
    const prefix = `${question.header}:`;
    const matching = lines.find((line) => line.startsWith(prefix));
    const raw = matching?.slice(prefix.length).trim() ?? (!hasStructuredAnswer && index === 0 ? text.trim() : '');
    const key = question.id ?? String(index);
    if (matching !== undefined) lastAnsweredKey = key;
    answers[key] = {
      answers: raw === '' ? [] : raw.split(',').map((answer) => answer.trim()).filter(Boolean),
    };
  }
  if (comment && lastAnsweredKey !== undefined) {
    answers[lastAnsweredKey]!.answers.push(`Additional comments:\n${comment}`);
  }
  return answers;
}
