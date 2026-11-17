import { AST_RULES } from './plugin.ts';
import { ruleCases } from './ast-rule.testkit.ts';

// Every former ast-grep case, with its original source and diagnostic count (hearsay-tools/squawk#3774).

ruleCases(AST_RULES.find(rule => rule.name === "agent-session-send-outside-handoff")!, {
  "file": "packages/cezar/src/fixture.ts",
  "valid": [
    "handToTransport(state, session, ids, wire => wire.sendAgentMessage(content, ids));",
    "handToTransport(state, session, [], wire => wire.sendMessage(content));",
    "manager.sendMessage(id, content);",
    "this.host.sendMessage(runId, entry.content, entry.messageId);",
    "host.sendMessage(id, content, messageId);",
    "this.sendMessage(runId, content);",
    "class Manager { #modules; send() { this.#modules.inputDelivery.sendMessage(runId, content, messageId); } }"
  ],
  "invalid": [
    "session.sendMessage(content);",
    "state.liveSession.session.sendMessage(content);",
    "session.sendAgentMessage(content, ids);",
    "state.inputState.writeInput(() => session.sendAgentMessage(content, ids));",
    "wire.sendMessage(content);",
    "this.manager.sendAgentMessage(content, ids);"
  ]
});

ruleCases(AST_RULES.find(rule => rule.name === "detached-spawn-outside-helper")!, {
  "file": "packages/cezar/src/fixture.ts",
  "valid": [
    "spawn('git', ['status'], { stdio: 'ignore' })",
    "spawn('git', ['status'], { detached: false })",
    "const options = { detachedAt: true }",
    "const detached = true",
    "child.detached === true"
  ],
  "invalid": [
    "spawn('xdg-open', [url], { stdio: 'ignore', detached: true })",
    "spawn('/bin/sh', ['-c', command], { cwd, env, detached: true, stdio: ['ignore', fd, fd] })",
    "const options = { 'detached': true }",
    "const options: SpawnOptions = { detached: true }"
  ]
});

ruleCases(AST_RULES.find(rule => rule.name === "e2e-raw-run-seed")!, {
  "file": "packages/web/e2e/fixture.e2e.ts",
  "valid": [
    "seedRuns(root, [{ id: 'fixture', status: RUN_STATUS.done }])",
    "writeFileSync(join(root, '.ai/cezar/config.json'), JSON.stringify(config))",
    "readFileSync(join(root, '.ai/cezar/runs.json'), 'utf8')",
    "writeFileSync('notes.txt', 'runs.json')"
  ],
  "invalid": [
    "writeFileSync(join(root, '.ai/cezar/runs.json'), JSON.stringify([run]))",
    "fs.writeFileSync(join(root, '.ai', 'cezar', 'runs.json'), '[]', 'utf8')",
    "await writeFile(join(root, 'runs.json'), JSON.stringify(runs))",
    "await fs.promises.writeFile(`${root}/.ai/cezar/runs.json`, '[]')",
    "const file = join(root, '.ai/cezar/runs.json'); writeFileSync(file, '[]')",
    "const file = 'runs.json'; appendFileSync(file, '[]')",
    "const file = join(root, 'runs.json'); createWriteStream(file)"
  ]
});

ruleCases(AST_RULES.find(rule => rule.name === "git-spawn-outside-helper")!, {
  "file": "packages/cezar/src/fixture.ts",
  "valid": [
    "await runGit(['status'], { cwd })",
    "gitSync(['rev-parse', 'HEAD'], { cwd })",
    "spawnGit(['status'], { cwd })",
    "await git(cwd, ['status'])",
    "spawn('gh', ['repo', 'clone', url])",
    "execFile('du', ['-sk', path])",
    "spawn(cmd, args)",
    "execFile(bin, args, options)",
    "const exec = async (cmd: string, args: string[]) => run(cmd, args); exec('git', ['init'])",
    "spawnCommandRunner('git', ['init'], options)",
    "joinPath(home, 'git', 'attributes')",
    "exec('github status')",
    "execFile('gitx', [])",
    "exec('git', ['status'])"
  ],
  "invalid": [
    "execFile('git', ['status'], { cwd })",
    "execFile(\"git\", args, options, callback)",
    "execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' })",
    "spawn('git', ['status'])",
    "spawnSync(`git`, ['status'])",
    "childProcess.spawn('git', ['status'])",
    "cp.execFile('git', ['status'], callback)",
    "promisify(execFile)('git', ['status'])",
    "const exec = promisify(execFile); exec('git', ['--version'])",
    "const run = promisify(execFile); async function f() { await run('git', ['status'], { cwd }) }",
    "exec('git status')",
    "execSync(`git rev-parse HEAD`)"
  ]
});

ruleCases(AST_RULES.find(rule => rule.name === "handoff-write-outside-writers")!, {
  "file": "packages/cezar/src/handoff.ts",
  "valid": [
    "export function seedHandoffFile(dataDir: string, run: HandoffSeed) { writeFileSync(file, header, 'utf8') }",
    "function writeHandoffRecords(dataDir: string, runId: string) { const write = () => writeFileSync(file, next, 'utf8'); write() }",
    "export function deleteHandoff(dataDir: string, runId: string) { rmSync(handoffPath(dataDir, runId), { force: true }) }",
    "function readHandoff(dataDir: string, runId: string) { return readFileSync(handoffPath(dataDir, runId), 'utf8') }",
    "mkdirSync(dirname(file), { recursive: true })"
  ],
  "invalid": [
    "export function appendHandoffHeartbeat(dataDir: string, runId: string, line: string) { appendFileSync(handoffPath(dataDir, runId), line) }",
    "function writeAutosaveSection(file: string, text: string) { writeFileSync(file, text, 'utf8') }",
    "const later = async () => fs.promises.writeFile(file, text)",
    "function rotate(file: string) { renameSync(file, `${file}.old`) }",
    "function drop(file: string) { unlinkSync(file) }"
  ]
});

ruleCases(AST_RULES.find(rule => rule.name === "handoff-written-outside-handoff-module")!, {
  "file": "packages/cezar/src/fixture.ts",
  "valid": [
    "recordHandoffAutosave(this.store, this.dataDir, runId, message)",
    "const text = readFileSync(handoffPath(dataDir, run.id), \"utf8\")",
    "rmSync(this.handoffPath(id), { force: true })",
    "writeFileSync(join(dataDir, \"runs\", `${id}.ndjson`), lines)"
  ],
  "invalid": [
    "appendFileSync(handoffPath(this.dataDir, runId), `- ${at} — turn complete\\n`)",
    "writeFileSync(handoffFile, text)",
    "await fs.promises.writeFile(process.env.CEZ_HANDOFF_FILE!, text)",
    "renameSync(tmp, this.handoffPath(id))"
  ]
});

ruleCases(AST_RULES.find(rule => rule.name === "liveness-timer-outside-owner")!, {
  "file": "packages/cezar/src/workflows/run/fixture.ts",
  "valid": [
    "const timer = this.timers.arm({ kind: 'idle-close', runId, delayMs }, expire)",
    "clearTimeout(timer)",
    "cancelLivenessTimer(state.boundary.idleTimer)",
    "let watchdog: ReturnType<typeof setInterval>",
    "queueMicrotask(run)",
    "setImmediate(run)"
  ],
  "invalid": [
    "const timer = setTimeout(() => expire(), 1000)",
    "this.autosaveTimer = setInterval(save, AUTOSAVE_INTERVAL_MS)",
    "globalThis.setTimeout(run, 0)",
    "await new Promise(resolve => setTimeout(resolve, 500))",
    "await timers.setTimeout(500)"
  ]
});

ruleCases(AST_RULES.find(rule => rule.name === "nudge-fact-write-outside-owner")!, {
  "file": "packages/cezar/src/fixture.ts",
  "valid": [
    "type Event = { kind: 'nudge-fact'; phase: 'retire' }",
    "const refused = state.boundary.nudge?.state === 'refused'",
    "transitionTurnBoundary(state, { kind: 'turn-started', phase: 'clear-boundary', session })",
    "return { kind: 'nudge', cause: 'no-wait', autonomous: true }",
    "retireNudge(state)"
  ],
  "invalid": [
    "transitionTurnBoundary(state, { kind: 'nudge-fact', phase: 'retire', session })",
    "transitionTurnBoundary(state, { kind: 'nudge-fact', phase: 'record', session, nudge: { cause: 'autonomous', state: 'refused' } })",
    "const event = { kind: \"nudge-fact\", phase: \"retire\" }"
  ]
});
