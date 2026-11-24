#!/usr/bin/env node
// The fixture runner's native mock (src/runners/fixture/): newline-delimited JSON over stdio.
// stdin takes `{"type":"prompt","text":"...","id":"..."}`; stdout answers `ready`, then per prompt
// `consumed` (when `id` is set), `turn-start`, `text`/`tool-start`/`tool-end`/`reasoning`/`progress`,
// `usage` and `turn-end` (or `error`). Drives the shared `mock-scenario.mjs` catalog and calls
// Squawk tools directly over `CEZ_TOOL_SOCKET` without spawning an MCP server subprocess.
import { appendFileSync, closeSync } from 'node:fs';
import readline from 'node:readline';
import { loadControls } from './mock-controls.mjs';
import { answerNudge } from './mock-nudge.mjs';
import { holdSteerLines, play, scenarioFor } from './mock-scenario.mjs';
import { withoutSessionContext } from './mock-session-context.mjs';

const { failureControl, delivery } = await loadControls({ failure: ['provider', 'usage-limit', 'unread'], delivery: ['hold-response'] });

const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tools = () => import('./mock-ci-tool.mjs');
async function lifecycle(call) {
  return (await tools()).lifecycleCall('fixture', process.argv.slice(2), ...call);
}

process.on('SIGTERM', () => process.exit(143));

if (process.env.CEZ_MOCK_ARGS_FILE) {
  try { appendFileSync(process.env.CEZ_MOCK_ARGS_FILE, `${JSON.stringify(process.argv.slice(2))}\n`); } catch {}
}

const sessionFlag = process.argv.includes('--resume') ? '--resume' : '--session-id';
const sessionIndex = process.argv.indexOf(sessionFlag);
const sessionId = sessionIndex >= 0 && process.argv[sessionIndex + 1] ? process.argv[sessionIndex + 1] : 'fixture-session-1';
write({ type: 'ready', sessionId });

const scenarioContext = {
  runner: 'fixture',
  lifecycle,
  session: {},
  unsupported: [],
  nativeFailureControl: Boolean(failureControl),
  toolPrompt: async (prompt) => (await tools()).toolPrompt('fixture', process.argv.slice(2), prompt),
  ciPrompt: async (prompt) => (await tools()).ciPrompt('fixture', process.argv.slice(2), prompt),
  async crash(prompt) {
    const { crashWithStderr } = await import('./mock-runner-crash.mjs');
    crashWithStderr(prompt, '{"type":"text",');
  },
};

let heldIds = [];
let steering = null;

function recordStdin(userText) {
  if (!process.env.CEZ_MOCK_STDIN_FILE) return;
  try { appendFileSync(process.env.CEZ_MOCK_STDIN_FILE, `${JSON.stringify({ userText })}\n`); } catch {}
}

const holdSteerTool = () => holdSteerLines(() => (steering ? steering.length : Number.POSITIVE_INFINITY));

function failureMessage(kind) {
  if (kind === 'usage-limit') {
    const configured = Number(process.env.CEZ_MOCK_LIMIT_RESET_SECONDS ?? '60');
    const seconds = Number.isFinite(configured) ? configured : 60;
    return `Claude AI usage limit reached|${Math.floor(Date.now() / 1000) + seconds}`;
  }
  return 'fixture provider rejected the request (API Error: 400 invalid_request_error)';
}

function scenarioEncoder(scenario, prompt, id) {
  const name = scenario.name;
  let steered = [];
  let turnOpened = false;
  const openTurn = () => {
    if (turnOpened) return;
    turnOpened = true;
    write({ type: 'turn-start' });
  };
  return {
    closeInput: () => closeSync(0),
    open(step) {
      if (name === 'ack-only') {
        if (id) heldIds.push(id);
        return;
      }
      if (step?.ackOnly) return;
      openTurn();
      if (name === 'steer-tool') steering = [];
    },
    hold: () => holdSteerTool(),
    reply: () => handlePrompt(prompt, id, false),
    text(step) {
      openTurn();
      write({ type: 'text', text: step.parts.join('') });
    },
    reasoning(step) {
      openTurn();
      write({ type: 'reasoning', text: step.text });
    },
    toolStart({ call }) {
      openTurn();
      write({ type: 'tool-start', call });
    },
    toolEnd({ call }) {
      write({ type: 'tool-end', call });
    },
    child(_step, playChild) {
      return playChild(scenarioEncoder(scenario, prompt, id));
    },
    progress: () => write({ type: 'progress' }),
    readSteers() {
      steered = steering ?? [];
      steering = null;
      const ids = steered.map((line) => line.id).filter(Boolean);
      if (ids.length) write({ type: 'consumed', ids });
      return steered.map((line) => line.userText);
    },
    end(step) {
      if (step?.error) {
        openTurn();
        write({ type: 'error', message: failureMessage(step.error) });
        return;
      }
      openTurn();
      write({ type: 'usage', input: 12, output: 8 });
      const consumedIds = [...heldIds.splice(0), ...(id ? [id] : []), ...steered.map((line) => line.id).filter(Boolean)];
      write({ type: 'turn-end', ...(consumedIds.length ? { consumedIds } : {}) });
    },
  };
}

async function resolveFailure(rawText, text) {
  const selected = failureControl?.failureFor(rawText) ?? failureControl?.failureFor(text);
  const resolved = selected instanceof Promise ? await selected : selected;
  if (resolved) return resolved;
  if (failureControl?.failure !== 'provider' && text.includes('mock:auth-error')) return 'provider';
  if (failureControl?.failure !== 'usage-limit' && text.includes('mock:limit')) return 'usage-limit';
  return undefined;
}

async function runScenario(scenario, text, id) {
  if (!scenario) return false;
  return await play(scenario, scenarioEncoder(scenario, text, id)) !== 'continue';
}

function writeDefaultTurn(text, id) {
  write({ type: 'turn-start' });
  write({ type: 'text', text: `fixture reply to: ${text}` });
  write({ type: 'usage', input: 12, output: 8 });
  const consumedIds = [...heldIds.splice(0), ...(id ? [id] : [])];
  write({ type: 'turn-end', ...(consumedIds.length ? { consumedIds } : {}) });
}

async function handlePrompt(rawText, id, record = true) {
  if (record) recordStdin(rawText);
  if (delivery) await delivery.holdResponse(rawText);
  const text = withoutSessionContext(answerNudge(rawText));
  const nativeFailure = await resolveFailure(rawText, text);
  if (nativeFailure === 'unread') process.exit(1);
  if (id) write({ type: 'consumed', ids: [id] });
  const early = scenarioFor(text, scenarioContext);
  if (early?.beforeFailure && await runScenario(early, text, id)) return;
  if (text.includes('mock:slow')) await sleep(25_000);
  if (nativeFailure === 'provider' || nativeFailure === 'usage-limit') {
    write({ type: 'turn-start' });
    write({ type: 'error', message: failureMessage(nativeFailure) });
    return;
  }
  const matched = early && !early.beforeFailure ? early : scenarioFor(text, scenarioContext);
  if (matched && !matched.beforeFailure && await runScenario(matched, text, id)) return;
  writeDefaultTurn(text, id);
}

const lines = readline.createInterface({ input: process.stdin });
let chain = Promise.resolve();
lines.on('line', (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message?.type !== 'prompt') return;
  if (steering !== null) {
    recordStdin(message.text);
    steering.push({ id: message.id, userText: message.text });
    return;
  }
  chain = chain.then(() => handlePrompt(message.text, message.id));
});
lines.on('close', () => { chain.then(() => process.exit(0)); });
