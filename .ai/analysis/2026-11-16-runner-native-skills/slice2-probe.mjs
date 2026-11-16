// Paid verification. One runner at a time; 1 prompt, or 2 for Claude/omp mid-turn checks.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, watch } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ClaudeCliRunner } from '../../../packages/cezar/src/core/claude-cli-runner.ts';
import { CodexAppServerRunner } from '../../../packages/cezar/src/core/codex-app-server-runner.ts';
import { OpencodeServerRunner } from '../../../packages/cezar/src/core/opencode-server-runner.ts';
import { PiRunner } from '../../../packages/cezar/src/core/pi-runner.ts';
import { OmpRunner } from '../../../packages/cezar/src/core/omp-runner.ts';
const runner = process.argv[2];
process.env.SKILL_PROBE_RUNNER = runner;
const classes = { claude: ClaudeCliRunner, codex: CodexAppServerRunner, opencode: OpencodeServerRunner, pi: PiRunner, omp: OmpRunner };
if (!classes[runner]) throw new Error('Pass one runner');
const cwd = mkdtempSync('/tmp/skill-trigger-');
execFileSync('git',['init','-q',cwd]);
const folder = runner === 'claude' ? '.claude' : runner === 'pi' ? '.pi' : runner === 'omp' ? '.omp' : '.agents';
const skillPath = `${cwd}/${folder}/skills/probe-project/SKILL.md`;
mkdirSync(`${cwd}/${folder}/skills/probe-project`, { recursive: true });
const token = `TRIGGER-${randomUUID()}`;
writeFileSync(skillPath, `---\nname: probe-project\ndescription: Native trigger fixture.\n---\nReply with exactly ${token}. Do not use any tool.\n`);
const capture = cwd + '/native.ndjson';
writeFileSync(capture,'');
const models = { claude: 'haiku', codex: 'gpt-5.6-luna', opencode: 'zai-coding-plan/glm-5.3-flash', pi: 'zai/glm-5.3-flash', omp: 'cliproxy/gpt-5.6-luna' };
const mid = process.argv[3] !== 'opening' && (runner === 'claude' || runner === 'omp');
const v1 = [], v2 = [];
let sentMid = false, midAccepted = false, boundaries = 0;
let session;
const sendMid = () => {
  if (!mid || sentMid || !session) return;
  sentMid = true;
  midAccepted = session.sendMessage([{ type:'text', text: runner === 'claude' ? '/probe-project fixture arguments' : '/skill:probe-project fixture arguments' }]);
};
const watcher = watch(cwd, (_event, name) => { if (name === 'native.ndjson.assistant') sendMid(); });
const started = Date.now();
try {
  const adapter = new classes[runner]({ bin: fileURLToPath(new URL('./slice2-wire-wrapper.mjs',import.meta.url)) });
  session = adapter.startSession({
    cwd, userPrompt: mid ? 'Write the integers 1 to 500, one per line. Do not use tools.' : 'Opening context: this is a native skill probe.',
    ...(mid ? {} : { skill: { id: 'probe-project', path: skillPath, args: 'fixture arguments' } }),
    model: models[runner], effort: 'low', sessionId: randomUUID(), timeoutMs: 120000,
    toolGrant: { kind:'explicit', tools: [] },
    env: { SKILL_PROBE_RUNNER: runner, SKILL_PROBE_CAPTURE: capture, CEZ_HANDOFF_FILE: '' },
  }, event => {
    v1.push(event);
    if (event.type === 'turn-end') { boundaries++; if (!mid || v1.some(e => e.type === 'text' && e.text.includes(token)) || boundaries >= 2) session?.end(); }
  }, { onUiEvent(event) {
    v2.push(event);

  } });
  const result = await session.result;
  const native = readFileSync(capture,'utf8');
  // Keep a small replayable excerpt: first trigger acknowledgement/user message and terminal reply.
  const frames = native.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const expansion = frames.filter(frame => {
    if (runner === 'claude') return frame.type === 'user' && JSON.stringify(frame).includes('<command-name>/probe-project');
    if (runner === 'codex') return frame.method === 'item/completed' && frame.params?.item?.type === 'userMessage';
    if (runner === 'opencode') return frame.type === 'message.updated' && frame.properties?.info?.role === 'user' || frame.type === 'message.part.updated' && frame.properties?.part?.text?.includes('Native trigger fixture') || frame.properties?.part?.text?.includes('Reply with exactly TRIGGER-');
    return frame.type === 'message_start' && (frame.message?.customType === 'skill-prompt' || (typeof frame.message?.content === 'string' ? frame.message.content : frame.message?.content?.map(p => p.text ?? '').join('')).includes('<skill name="probe-project"'));
  });
  const normalized = JSON.parse(JSON.stringify(expansion).replaceAll(cwd,'/probe/repo').replaceAll(token,'TRIGGER-FIXTURE'));
  const output = fileURLToPath(new URL(`../../../packages/cezar/src/core/__fixtures__/${runner}/skill-trigger.json`,import.meta.url));
  if (normalized.length) writeFileSync(output,JSON.stringify(normalized,null,2)+'\n');
  const summary = { runner, model:models[runner], elapsedMs:Date.now()-started, tokenReturned: result.text.includes(token), tools:result.toolCalls.length, sentMid, midAccepted, boundaries, expansionFrames:expansion.length, session:v1.filter(e=>e.type==='session'), errors:v1.filter(e=>e.type==='error'), userItems:v2.filter(e=>e.type==='item.completed' && e.item.kind==='message' && e.item.role==='user').map(e=>e.item.text) };
  console.log(JSON.stringify(summary));
  writeFileSync(fileURLToPath(new URL(`./slice2-${runner}-${mid ? 'mid' : 'opening'}-result.json`,import.meta.url)),JSON.stringify(summary,null,2)+'\n');
  if (!summary.tokenReturned || summary.tools || !expansion.length) process.exitCode=1;
} finally { watcher.close(); session?.end(); rmSync(cwd,{recursive:true,force:true}); }
