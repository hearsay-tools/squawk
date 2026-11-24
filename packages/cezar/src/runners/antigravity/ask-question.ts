import { z } from 'zod';
import type { UiAskQuestion } from '@hearsay-tools/squawk/plugin';

const RECOMMENDED = /^\(Recommended\)\s*/;
const inputSchema = z.object({ questions: z.array(z.object({
  question: z.string().min(1), options: z.array(z.string()).optional(), is_multi_select: z.boolean().optional(),
})).min(1) });

/**
 * The card for the CLI's `ask_question` call (cli-interaction-question.ndjson). The CLI reads the
 * next prompt as the answer, so free text stays allowed. A list outside the card's two to four
 * options becomes an open question that names them.
 */
export function antigravityQuestion(input: unknown): UiAskQuestion | undefined {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return undefined;
  const asked = parsed.data.questions;
  const labels = (options: readonly string[]) => options.map(option => option.replace(RECOMMENDED, '').slice(0, 60));
  const listed = asked.map(entry => {
    const options = labels(entry.options ?? []);
    const choices = options.length >= 2 && options.length <= 4 && new Set(options).size === options.length;
    return { entry, options: choices ? options : [], text: choices || !options.length ? entry.question : `${entry.question} (${options.join(' / ')})` };
  });
  const first = listed[0]!;
  if (listed.length === 1) {
    return { header: 'Question', question: first.text.slice(0, 400),
      ...(first.options.length ? { options: first.options.map((label, index) => ({ label,
        ...(RECOMMENDED.test(first.entry.options![index]!) ? { description: 'Recommended' } : {}) })) } : {}),
      ...(first.entry.is_multi_select ? { multiSelect: true } : {}) };
  }
  // Several questions share one answer prompt: ask them as one open question.
  return { header: 'Question', question: listed.map(item => item.text).join('\n').slice(0, 400) };
}

/** The card answers `Question: <choice>`; the CLI takes the choice's own words. */
export function antigravityAnswer(question: UiAskQuestion, answer: string): string {
  const text = answer.trim().replace(new RegExp(`^${question.header}:\\s*`), '');
  return text || answer;
}
