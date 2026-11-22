#!/usr/bin/env node
// The Antigravity CLI's sign-in, version and configOptions surface; no model/provider calls.
// Self-contained: tests copy it to a temporary `agy`.
import { createInterface } from 'node:readline';
import { mkdirSync, existsSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
if (process.argv.includes('--version')) {
  if (process.env.AGY_MOCK_VERSION_LOG) appendFileSync(process.env.AGY_MOCK_VERSION_LOG, 'version\n');
  console.log(process.env.AGY_MOCK_VERSION || '1.5.14');
  process.exit(0);
}
if (process.argv.includes('--help')) { console.log('Usage of antigravity:\n  acp  Start the Agent Client Protocol (ACP) stdio server'); process.exit(0); }
const flag = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const geminiDir = flag('--gemini-dir');
const appData = join(geminiDir, flag('--app-data-dir'));
const signedIn = join(appData, 'mock-login.json');
if (process.argv.includes('--login')) {
  const redirect = encodeURIComponent('https://antigravity.google/oauth-callback');
  console.log('Open this link in a browser to log in with Google:\n');
  console.log(`  https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=mock&prompt=consent&redirect_uri=${redirect}&response_type=code&scope=openid&state=fixture-state\n`);
  console.log('Then paste the authorization code, or the full URL of the page you land on, and press Enter:');
  const lines = createInterface({ input: process.stdin });
  const line = await new Promise(resolve => { lines.once('line', resolve); lines.once('close', () => resolve('')); });
  lines.close();
  if (process.env.AGY_MOCK_LOGIN_LOG) appendFileSync(process.env.AGY_MOCK_LOGIN_LOG, `${line}\n`);
  if (!line.trim()) { console.error('login cancelled: no authorization code was entered'); process.exit(1); }
  if (line.includes('mock-refused')) { console.error('login failed: invalid_grant'); process.exit(1); }
  mkdirSync(appData, { recursive: true }); writeFileSync(signedIn, '{"mock":"signed-in"}');
  process.exit(0);
}
const write = (id, result) => console.log(JSON.stringify({ jsonrpc: '2.0', id, result }));
const fail = (id, message) => console.log(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32603, message } }));
const configs = model => [{ id: 'model', category: 'model', options: [
  { value: 'opaque/flash', name: 'Flash' }, { value: 'opaque/pro', name: 'Pro' },
] }, { id: 'thought_level', category: 'thought_level', options: (model === 'opaque/pro' ? ['low', 'high'] : ['low', 'medium', 'high']).map(value => ({ value, name: value })) }];
function authenticate(frame) {
  if (frame.params.methodId === 'oauth-personal' && !existsSync(signedIn)) {
    fail(frame.id, 'No browser is available here (this is a remote (SSH) session, so the browser\'s sign-in redirect can\'t reach this machine). Run `agy acp --login` in a terminal on this machine, then retry; or use a Gemini API key.');
    return;
  }
  mkdirSync(join(appData, 'cache'), { recursive: true });
  writeFileSync(join(appData, 'cache', 'acp-auth-state.json'), JSON.stringify({ methodId: frame.params.methodId }));
  write(frame.id, {});
}
const lines = createInterface({ input: process.stdin });
lines.on('line', line => {
  const frame = JSON.parse(line);
  if (process.env.AGY_MOCK_WIRE) appendFileSync(process.env.AGY_MOCK_WIRE, `${line}\n`);
  if (frame.method === 'initialize') write(frame.id, { protocolVersion: 1, agentCapabilities: {}, authMethods: [
    { id: 'oauth-personal', name: 'Personal' }, { id: 'gemini-api-key', name: 'API key' },
  ] });
  else if (frame.method === 'authenticate') authenticate(frame);
  else if (frame.method === 'session/new') {
    if (!process.env.GEMINI_API_KEY && !existsSync(signedIn)) { fail(frame.id, 'Authentication required'); return; }
    const folder = join(appData, 'conversations');
    mkdirSync(folder, { recursive: true }); writeFileSync(join(folder, 'catalog-fixture.db'), '{}');
    if (process.env.AGY_MOCK_HOME_LOG) appendFileSync(process.env.AGY_MOCK_HOME_LOG, `${geminiDir}\n`);
    write(frame.id, { sessionId: 'catalog-fixture', configOptions: process.env.AGY_MOCK_BAD_MODELS ? [] : configs('opaque/flash') });
  }
  else if (frame.method === 'session/set_config_option') write(frame.id, { configOptions: configs(frame.params.value) });
});
lines.on('close', () => process.exit(0));
