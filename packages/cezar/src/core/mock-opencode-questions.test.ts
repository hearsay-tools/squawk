import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { answersLibraryQuestion, bodyAnswersLibraryQuestion } from '../../scripts/mock-ask-answer.mjs';
import { questionReplies } from '../../scripts/mock-opencode-questions.mjs';

// hearsay-tools/squawk#2701: the OpenCode mock's native question, and the answer that opens a
// session an idle close reopened, run in this process so their functions carry coverage.
const body = (text: string) => JSON.stringify({ parts: [{ type: 'text', text }] });

function harness() {
  const events: { type: string; properties: Record<string, unknown> }[] = [];
  const replies = questionReplies({
    send: event => { events.push(event); },
    info: extra => ({ id: 'msg', ...extra }),
    finishText: async text => `${text} [done]`,
    sessionId: () => 'ses',
    messageId: 'msg',
  });
  const route = (text: string) => replies.promptRoutes.find(([matches]) => matches(text))?.[1];
  const response = () => {
    const res = { status: 0, body: '', writeHead(status: number) { res.status = status; }, end(text: string) { res.body = text; } };
    return res;
  };
  const types = () => events.map(event => event.type);
  const answerText = () => events.find(event => (event.properties.part as { id?: string } | undefined)?.id === 'prt_answer')
    ?.properties.part as { text: string } | undefined;
  return { events, replies, route, response, types, answerText };
}

describe('mock ask answers', () => {
  it('reads the library answer only as a line of its own', () => {
    expect(answersLibraryQuestion('System\n\n---\n\nLibrary: Vitest\n\nmock:native-codex-ask')).toBe(true);
    expect(answersLibraryQuestion('Library: Vitest')).toBe(true);
    expect(answersLibraryQuestion('mock:native-codex-ask mock:resume-cezar-done')).toBe(false);
    expect(answersLibraryQuestion('Library: Vitest, please')).toBe(false);
    expect(answersLibraryQuestion(undefined)).toBe(false);
  });

  it('reads an OpenCode body by its text parts', () => {
    expect(bodyAnswersLibraryQuestion(body('Library: Vitest\n\nmock:ask mock:resume-cezar-done'))).toBe(true);
    expect(bodyAnswersLibraryQuestion(body('mock:ask mock:resume-cezar-done'))).toBe(false);
    expect(bodyAnswersLibraryQuestion(JSON.stringify({ parts: 'none' }))).toBe(false);
    expect(bodyAnswersLibraryQuestion('not json')).toBe(false);
  });
});

describe('mock OpenCode questions', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('asks and holds the turn, then resumes it with the reply and finishes', async () => {
    const { replies, route, response, types, answerText } = harness();
    await route(body('mock:ask mock:resume-cezar-done'))!(body('mock:ask mock:resume-cezar-done'));
    expect(replies.pendingQuestions).toEqual([{ id: 'q_mock_1', sessionID: 'ses' }]);
    expect(types()).toEqual(['message.updated', 'message.part.updated']);
    const res = response();
    replies.replyToQuestion({}, res, '/question/q_mock_1/reply', '{"answers":[["Vitest"]]}');
    expect(res.status).toBe(200);
    expect(replies.pendingQuestions).toEqual([]);
    await vi.advanceTimersByTimeAsync(30);
    expect(answerText()?.text).toBe('human answer: {"answers":[["Vitest"]]} [done]');
    await vi.advanceTimersByTimeAsync(1);
    expect(types().at(-1)).toBe('session.idle');
  });

  it('acknowledges a late reply after 250 ms and answers without finishing', async () => {
    const { replies, route, response, answerText } = harness();
    await route(body('mock:ask-reply-late'))!(body('mock:ask-reply-late'));
    const res = response();
    replies.replyToQuestion({}, res, '/question/q_mock_1/reply', 'yes');
    expect(res.status).toBe(0);
    await vi.advanceTimersByTimeAsync(250);
    expect(res.status).toBe(200);
    expect(answerText()?.text).toBe('human answer: yes');
  });

  it('sends no answer for a rejected question', async () => {
    const { replies, route, response, types } = harness();
    await route(body('mock:ask'))!(body('mock:ask'));
    replies.replyToQuestion({}, response(), '/question/q_mock_1/reject', '');
    await vi.advanceTimersByTimeAsync(300);
    expect(types()).toEqual(['message.updated', 'message.part.updated']);
  });

  it('ends the turn after a malformed ask', async () => {
    const { replies, route, types } = harness();
    await route(body('mock:ask-bad'))!(body('mock:ask-bad'));
    expect(replies.pendingQuestions).toEqual([{ id: 'q_mock_bad', sessionID: 'ses' }]);
    await vi.advanceTimersByTimeAsync(60);
    expect(types()).toEqual(['message.updated', 'message.part.updated', 'session.idle']);
  });

  it('answers a reopened session that opens with the answer instead of asking again', async () => {
    const { replies, route, types, answerText } = harness();
    const reopened = body('Library: Vitest\n\nCurrent task and queued updates:\n\nmock:ask mock:resume-cezar-done');
    await route(reopened)!(reopened);
    expect(replies.pendingQuestions).toEqual([]);
    expect(answerText()?.text).toBe(`human answer: ${reopened} [done]`);
    await vi.advanceTimersByTimeAsync(30);
    expect(types()).toEqual(['message.updated', 'message.part.updated', 'session.idle']);
  });
});
