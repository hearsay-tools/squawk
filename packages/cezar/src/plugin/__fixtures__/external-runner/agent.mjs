// The external runner's own CLI: a stand-in agent with no Squawk imports. It reads JSON prompt
// lines on stdin and writes JSON frames on stdout. Each prompt gets one reply that names the account
// folder it ran with. The first prompt writes EXTERNAL_RUNNER.md in the working directory, so the
// task has a change to review, and ends the task with `cezar_done` over the tool socket Squawk
// passes to every session.
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
if (args[0] === 'status') {
  process.stdout.write('signed in\n');
  process.exit(0);
}
if (args[0] === '--version') {
  process.stdout.write('ext-agent 1.0.0\n');
  process.exit(0);
}

const flag = name => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const env = name => process.env[`HSQ_${name}`] ?? process.env[`CEZ_${name}`];
const write = frame => { process.stdout.write(`${JSON.stringify(frame)}\n`); };

function callTool(name, input) {
  const socketPath = env('TOOL_SOCKET');
  const token = env('TOOL_TOKEN');
  if (!socketPath || !token) return Promise.resolve({ isError: true, content: [{ type: 'text', text: 'no tool socket' }] });
  return new Promise((resolve, reject) => {
    const req = request({
      socketPath, agent: false, method: 'POST', path: `/api/v1/tools/${encodeURIComponent(name)}`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/x-squawk-tool-result+json' },
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
    req.end(JSON.stringify(input));
  });
}

write({ type: 'ready', sessionId: flag('--resume') ?? flag('--session-id') ?? randomUUID() });

let done = false;
async function answer(prompt) {
  write({ type: 'turn-start' });
  if (prompt.id) write({ type: 'consumed', ids: [prompt.id] });
  write({ type: 'text', text: `external runner reply: account=${process.env.EXT_AGENT_HOME ?? '(default)'}` });
  write({ type: 'usage', input: 3, output: 4 });
  if (!done) {
    writeFileSync('EXTERNAL_RUNNER.md', prompt.text);
    const call = { id: randomUUID(), name: 'cezar_done', input: {} };
    write({ type: 'tool-start', call });
    const response = await callTool('cezar_done', {}).catch(error => ({ isError: true, content: [{ type: 'text', text: String(error) }] }));
    done = response?.isError !== true;
    write({ type: 'tool-end', call: { ...call, output: JSON.stringify(response), isError: !done } });
  }
  write({ type: 'turn-end' });
}

let queue = Promise.resolve();
const lines = createInterface({ input: process.stdin });
lines.on('line', line => {
  let prompt;
  try { prompt = JSON.parse(line); } catch { return; }
  if (prompt?.type === 'prompt') queue = queue.then(() => answer(prompt));
});
lines.on('close', () => { void queue.then(() => process.exit(0)); });
