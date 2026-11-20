#!/usr/bin/env node
// The fixture runner's native mock (src/runners/fixture/): newline-delimited JSON over stdio.
// stdin takes `{"type":"prompt","text":"..."}`; stdout answers `ready`, then per prompt
// `turn-start`, `text`, `usage` and `turn-end`. `mock:hold` waits before the reply, and
// `mock:provider-error` answers with an `error` frame. Any other prompt is a plain reply.
import readline from 'node:readline';

const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

process.on('SIGTERM', () => process.exit(143));
write({ type: 'ready', sessionId: 'fixture-session-1' });

const lines = readline.createInterface({ input: process.stdin });
let chain = Promise.resolve();
lines.on('line', (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message?.type !== 'prompt') return;
  chain = chain.then(async () => {
    write({ type: 'turn-start' });
    if (message.text.includes('mock:provider-error')) { write({ type: 'error', message: 'fixture provider rejected the request' }); return; }
    if (message.text.includes('mock:hold')) await sleep(300);
    write({ type: 'text', text: `fixture reply to: ${message.text}` });
    write({ type: 'usage', input: 12, output: 8 });
    write({ type: 'turn-end' });
  });
});
lines.on('close', () => { chain.then(() => process.exit(0)); });
