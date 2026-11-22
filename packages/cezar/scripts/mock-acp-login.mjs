// `antigravity acp --login`: a consent link, then one pasted line. A code or the landing URL signs
// the account in; the mock records that beside the account's CLI data, as no credential.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import readline from 'node:readline';

export async function mockLogin(geminiDir) {
  const state = 'mock-state';
  console.log('Open this link in a browser to log in with Google:\n');
  console.log(`  https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=mock&code_challenge=mock&code_challenge_method=S256&prompt=consent&redirect_uri=${encodeURIComponent('https://antigravity.google/oauth-callback')}&response_type=code&scope=openid&state=${state}\n`);
  console.log('Then paste the authorization code, or the full URL of the page you land on, and press Enter:');
  const lines = readline.createInterface({ input: process.stdin });
  const line = await new Promise(resolve => { lines.once('line', resolve); lines.once('close', () => resolve('')); });
  lines.close();
  if (!line.trim()) { console.error('login cancelled: no authorization code was entered'); return 1; }
  if (line.trim() === 'mock-refused') { console.error('login failed: invalid_grant'); return 1; }
  mkdirSync(join(geminiDir, 'antigravity-cli'), { recursive: true });
  writeFileSync(join(geminiDir, 'antigravity-cli', 'mock-login.json'), JSON.stringify({ signedIn: true }));
  return 0;
}
