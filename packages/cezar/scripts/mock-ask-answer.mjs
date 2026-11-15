// hearsay-tools/squawk#2701: an idle close drops a native question that holds its turn open, and
// the answer opens the reopened session as its first message. A Continue repeats the task, so a
// mock that matched only its scenario tokens would ask again; it reads the answer first.
const ANSWER_LINE = /(?:^|\n)Library: Vitest(?:\n|$)/;

/** Whether `text` carries the answer to the mock's library question as a line of its own. */
export function answersLibraryQuestion(text) {
  return typeof text === 'string' && ANSWER_LINE.test(text);
}

/** The same for an OpenCode request body: any text part carries the answer. */
export function bodyAnswersLibraryQuestion(body) {
  try {
    const parts = JSON.parse(body).parts;
    return Array.isArray(parts) && parts.some(part => answersLibraryQuestion(part?.text));
  } catch {
    return false;
  }
}
