#!/usr/bin/env node
// A transparent real-CLI recorder. Only native turn frames enter the capture.
import { spawn } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
const runner = process.env.SKILL_PROBE_RUNNER;
const args = process.argv.slice(2);
if (runner === 'claude' && !args.includes('--help') && !args.includes('--version')) args.push('--include-partial-messages');
const child = spawn(runner, args, { stdio: ['pipe', 'pipe', 'inherit'] });
process.stdin.pipe(child.stdin);
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
let proxy;
child.on('exit', (code, signal) => { proxy?.closeAllConnections(); proxy?.close(); process.exitCode = code ?? (signal === 'SIGTERM' ? 143 : signal === 'SIGINT' ? 130 : 1); });
const keep = (frame) => {
  if (runner === 'opencode') return ['message.updated','message.part.updated','message.part.delta','session.idle','session.error','command.executed'].includes(frame.type);
  if (frame.type === 'system' && frame.subtype === 'init') return { type: frame.type, subtype: frame.subtype, session_id: frame.session_id, model: frame.model };
  if (frame.type === 'response') return frame.command === 'prompt' ? frame : false;
  if (runner === 'codex') return ['item/started','item/completed','turn/started','turn/completed','item/agentMessage/delta'].includes(frame.method);
  return ['user','assistant','result','message_start','message_end','message_update','agent_start','agent_end','agent_settled','session_settled','prompt_result','tool_execution_start'].includes(frame.type);
};
let signalled = false;
function record(frame) {
  if (!signalled && (frame.type === 'assistant' || frame.type === 'stream_event' || frame.type === 'message_update')) {
    signalled = true;
    if (process.env.SKILL_PROBE_CAPTURE) writeFileSync(process.env.SKILL_PROBE_CAPTURE + '.assistant', String(Date.now()));
  }
  const selected = keep(frame);
  if (selected && process.env.SKILL_PROBE_CAPTURE) appendFileSync(process.env.SKILL_PROBE_CAPTURE, JSON.stringify(typeof selected === 'object' ? selected : frame) + '\n');
}
let buffer = '';
child.stdout.on('data', (data) => {
  buffer += data;
  let end;
  while ((end = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
    if (runner === 'opencode' && args[0] === 'serve' && /http:\/\/127\.0\.0\.1:\d+/.test(line)) {
      const upstream = line.match(/http:\/\/127\.0\.0\.1:\d+/)[0];
      proxy = http.createServer((request, response) => {
        const outgoing = http.request(upstream + request.url, { method: request.method, headers: request.headers }, incoming => {
          response.writeHead(incoming.statusCode, incoming.headers);
          let frames = '';
          incoming.on('data', chunk => {
            if (request.url === '/event') {
              frames += chunk;
              let split;
              while ((split = frames.indexOf('\n\n')) >= 0) {
                const frame = frames.slice(0,split); frames = frames.slice(split+2);
                for (const part of frame.split('\n')) if (part.startsWith('data:')) {
                  try { record(JSON.parse(part.slice(5))); } catch { /* non-json */ }
                }
              }
            }
          });
          incoming.pipe(response);
        });
        outgoing.on('error', () => response.destroy());
        request.pipe(outgoing);
      });
      proxy.listen(0,'127.0.0.1', () => process.stdout.write(line.replace(upstream, `http://127.0.0.1:${proxy.address().port}`)+'\n'));
    } else {
      try { record(JSON.parse(line)); } catch { /* banners */ }
      process.stdout.write(line+'\n');
    }
  }
});
