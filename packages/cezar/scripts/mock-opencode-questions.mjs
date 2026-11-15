// The OpenCode mock's native `question` tool: an ask that holds its turn open, a malformed ask,
// the reply that resumes the held turn, and an answer that opens a session an idle close
// reopened (hearsay-tools/squawk#2701).
import { bodyAnswersLibraryQuestion } from './mock-ask-answer.mjs';

/** The question routes over the mock's SSE `send`, its assistant `info`, `finishText` and ids. */
export function questionReplies({ send, info, finishText, sessionId, messageId }) {
  /** Questions the runner can look up an id for. `replyQuestion`/`rejectQuestion`
   *  resolve the id through `GET /question` before answering (see
   *  `opencode-server-runner.ts`), so a native ask needs an entry here. */
  const pendingQuestions = [];
  let lateQuestionReply = false;
  let answerDone = false;
  const idle = () => send({ type: 'session.idle', properties: { sessionID: sessionId() } });

  /** The question tool arrives as a `tool` part whose state.input holds it —
   *  the shape `opencode-server-runner.test.ts`'s sendQuestion helper drives. */
  const sendQuestionPart = (input) => send({ type: 'message.part.updated', properties: { part: {
    id: 'prt_mock_question', messageID: messageId, sessionID: sessionId(), type: 'tool',
    callID: 'call_mock_question', tool: 'question', state: { status: 'running', input },
  } } });

  /** The answering text part, then `session.idle` after `holdMs`. */
  const sendAnswer = (text, holdMs) => {
    send({ type: 'message.part.updated', properties: { part: {
      id: 'prt_answer', messageID: messageId, sessionID: sessionId(), type: 'text', text,
    } } });
    setTimeout(idle, holdMs);
  };

  function replyToQuestion(req, res, url, body) {
    // Native question reply resumes the held turn, then its own session.idle
    // ends it (same SSE lifecycle shape as the baseline; never the HTTP ack).
    const answered = pendingQuestions.some(question => question.id === 'q_mock_1');
    pendingQuestions.length = 0;
    if (answered && url.endsWith('/reply')) setTimeout(async () => {
      // CEZ_MOCK_OPENCODE_REPLY_HOLD_MS keeps the answered turn running.
      sendAnswer(answerDone ? await finishText(`human answer: ${body}`) : `human answer: ${body}`,
        Number(process.env.CEZ_MOCK_OPENCODE_REPLY_HOLD_MS ?? 0));
    }, 30);
    const acknowledge = () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); };
    if (lateQuestionReply) setTimeout(acknowledge, 250);
    else acknowledge();
  }

  async function replyWithMalformedAsk() {
    // Malformed: `questions` is not an array, so the runner must REJECT the
    // native question and finish the turn rather than wait for an answer to
    // a card that can never render (the rejection path, harness parity R4).
    send({ type: 'message.updated', properties: { info: info({}) } });
    pendingQuestions.push({ id: 'q_mock_bad', sessionID: sessionId() });
    sendQuestionPart({ questions: 'not-an-array' });
    setTimeout(idle, 60);
  }

  async function replyWithAsk(body) {
    lateQuestionReply = body.includes('mock:ask-reply-late');
    answerDone = body.includes('mock:ask-reply-late-cezar-done') || body.includes('mock:resume-cezar-done');
    // The native question tool. No `session.idle` follows: a real ask
    // holds the turn open until the answer is routed back.
    send({ type: 'message.updated', properties: { info: info({}) } });
    pendingQuestions.push({ id: 'q_mock_1', sessionID: sessionId() });
    sendQuestionPart({ questions: [{
      header: 'Library',
      question: 'Which test library?',
      options: [
        { label: 'Vitest', description: 'Use the existing test runner' },
        { label: 'Node test', description: 'Use node:test' },
      ],
    }] });
  }

  /** The answer to a question an idle close dropped opens the reopened session: no new ask. */
  async function replyWithReopenedAnswer(body) {
    send({ type: 'message.updated', properties: { info: info({}) } });
    sendAnswer(await finishText(`human answer: ${body}`), 30);
  }

  return {
    pendingQuestions,
    replyToQuestion,
    /** Prompt routes, in order: a malformed ask, a reopened answer, then an ask. */
    promptRoutes: [
      [body => body.includes('mock:ask-bad'), replyWithMalformedAsk],
      [body => body.includes('mock:resume-cezar-done') && bodyAnswersLibraryQuestion(body), replyWithReopenedAnswer],
      [body => body.includes('mock:ask'), replyWithAsk],
    ],
  };
}
