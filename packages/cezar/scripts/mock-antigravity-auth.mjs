#!/usr/bin/env node
// Native authentication and configOptions fixture; no model/provider calls.
import { createInterface } from 'node:readline';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
if (process.argv.includes('--version')) {
  if (process.env.AGY_MOCK_VERSION_LOG) appendFileSync(process.env.AGY_MOCK_VERSION_LOG, 'version\n');
  console.log(`antigravity_extensions/acp_server\nBuild label: ${process.env.AGY_MOCK_VERSION || '1.5.0'}`);
  process.exit(0);
}
const write = (id, result) => console.log(JSON.stringify({ jsonrpc: '2.0', id, result }));
const settings = method => {
  const dir = join(process.env.GEMINI_HOME, 'antigravity-acp');
  mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'settings.json'), JSON.stringify({ auth: { type: method } }));
};
const configs = model => [{ id: 'model', category: 'model', options: [
  { value: 'opaque/flash', name: 'Flash' }, { value: 'opaque/pro', name: 'Pro' },
] }, { id: 'thinking_level', category: 'thought_level', options: (model === 'opaque/pro' ? ['low', 'high'] : ['low', 'medium', 'high']).map(value => ({ value, name: value })) }];
let listener;
async function authenticate(frame) {
  if (frame.params.methodId !== 'oauth-personal') { settings(frame.params.methodId); write(frame.id, {}); return; }
  listener = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.searchParams.get('state') !== 'fixture-state' || !url.searchParams.get('code')) { res.writeHead(400).end(); return; }
    const config = join(process.env.HOME, '.config/antigravity');
    mkdirSync(config, { recursive: true }); writeFileSync(join(config, 'plugin-secrets.json'), '{"mock":"account-owned"}');
    settings('oauth-personal'); writeFileSync(join(process.env.GEMINI_HOME, 'antigravity-acp/acp_token.json'), '{"mock":"oauth-fixture"}');
    res.end('Signed in'); listener.close(); write(frame.id, {});
  });
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const url = new URL('https://accounts.google.com/o/oauth2/auth');
  url.searchParams.set('redirect_uri', `http://127.0.0.1:${listener.address().port}/`); url.searchParams.set('state', 'fixture-state');
  const quoted = `'${url.href.replaceAll("'", "'\\''")}'`;
  const helper = spawn('/bin/sh', ['-c', process.env.BROWSER.replace('%s', quoted)], { stdio: 'ignore' });
  helper.on('error', () => {});
}
const lines = createInterface({ input: process.stdin });
lines.on('line', line => {
  const frame = JSON.parse(line);
  if (process.env.AGY_MOCK_WIRE) appendFileSync(process.env.AGY_MOCK_WIRE, `${line}\n`);
  if (frame.method === 'initialize') write(frame.id, { protocolVersion: 1, agentCapabilities: {}, authMethods: [
    { id: 'oauth-personal', name: 'Personal' }, { id: 'gemini-api-key', name: 'API key' },
  ] });
  else if (frame.method === 'authenticate') void authenticate(frame);
  else if (frame.method === 'session/new') {
    if (!process.env.GEMINI_API_KEY) {
      readFileSync(join(process.env.GEMINI_HOME, 'antigravity-acp/settings.json'));
      readFileSync(join(process.env.GEMINI_HOME, 'antigravity-acp/acp_token.json'));
      writeFileSync(join(process.env.GEMINI_HOME, 'antigravity-acp/acp_token.json'), '{"mock":"refreshed"}');
    }
    const folder = join(process.env.GEMINI_HOME, 'antigravity-acp/conversations');
    mkdirSync(folder, { recursive: true }); writeFileSync(join(folder, 'catalog-fixture.json'), '{}');
    if (process.env.AGY_MOCK_HOME_LOG) appendFileSync(process.env.AGY_MOCK_HOME_LOG, `${process.env.GEMINI_HOME}\n`);
    write(frame.id, { sessionId: 'catalog-fixture', configOptions: process.env.AGY_MOCK_BAD_MODELS ? [] : configs('opaque/flash') });
  }
  else if (frame.method === 'session/set_config_option') write(frame.id, { configOptions: configs(frame.params.value) });
});
lines.on('close', () => { listener?.close(); process.exit(0); });
