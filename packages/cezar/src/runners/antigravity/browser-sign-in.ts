import { createInterface } from 'node:readline';
import { rm } from 'node:fs/promises';
import { inspect } from 'node:util';
import type { RunnerBrowserSignIn } from '../../core/runner-definition.ts';
import { profileEnv } from '../../core/agent-profiles.ts';
import { productEnv } from '../../core/product-env.ts';
import { spawnSessionLeader, signalSession } from '../../core/session-process.ts';
import { BrowserSignInStartError, redactBrowserSignInDetails } from '../../core/browser-sign-in-error.ts';
import { antigravityEnv } from './runtime-env.ts';
import { antigravityLaunchArgs } from './launch-args.ts';
import { ANTIGRAVITY_MISSING, launchAntigravity, missingAntigravity } from './executable.ts';

/** Where `agy acp --login` sends Google. That page shows a code; its URL also carries it. */
export const ANTIGRAVITY_CODE_REDIRECT = 'https://antigravity.google/oauth-callback';
const SIGN_IN_TIMEOUT_MS = 600_000;
const URL_TIMEOUT_MS = 15_000;

function consentUrl(value: string): URL {
  const url = new URL(value);
  if (url.origin !== 'https://accounts.google.com' || url.pathname !== '/o/oauth2/auth' || url.username || url.password || url.hash
    || url.searchParams.getAll('state').length !== 1 || !url.searchParams.get('state')
    || url.searchParams.getAll('redirect_uri').length !== 1 || url.searchParams.get('redirect_uri') !== ANTIGRAVITY_CODE_REDIRECT
    || url.searchParams.get('response_type') !== 'code') throw new Error('Invalid consent URL');
  return url;
}

/**
 * What the CLI may read after its link: the code the Antigravity page shows, or that page's URL,
 * which must answer this sign-in. Anything else, including a line break, is refused.
 */
export function antigravityLoginResponse(consent: string, value: string): string {
  const text = value.trim();
  if (/^[\w./~-]{1,2048}$/.test(text)) return text;
  const state = consentUrl(consent).searchParams.get('state');
  let url: URL | undefined;
  try { url = new URL(text); } catch { /* refused below */ }
  if (!url || /\s/.test(text) || `${url.origin}${url.pathname}` !== ANTIGRAVITY_CODE_REDIRECT || url.username || url.password
    || url.searchParams.getAll('state').length !== 1 || url.searchParams.get('state') !== state
    || url.searchParams.getAll('code').length !== 1 || !url.searchParams.get('code')) {
    throw new Error('Paste the code shown after Google sign-in, or the full address of that page.');
  }
  return text;
}

/** `agy acp --login` prints a consent link and reads the pasted code on stdin. No code or URL is logged. */
export async function startAntigravitySignIn(accountHome?: string): Promise<RunnerBrowserSignIn> {
  const runtime = antigravityEnv({ env: { ...profileEnv('antigravity', accountHome), BROWSER: '/bin/false' } });
  const launch = launchAntigravity(productEnv('ANTIGRAVITY_BIN')) ?? missingAntigravity(runtime.temp);
  let stderr = '';
  let spawnError: Error | undefined;
  const child = spawnSessionLeader(launch.executable, antigravityLaunchArgs(runtime.geminiDir, ['--login']), { cwd: runtime.temp, env: runtime.env });
  const exited = new Promise<number | null>(resolve => child.once('close', code => resolve(code)));
  let cleanup: Promise<void> | undefined;
  const close = () => cleanup ??= (async () => {
    if (child.exitCode === null && child.signalCode === null) signalSession(child, 'SIGTERM');
    const kill = setTimeout(() => signalSession(child, 'SIGKILL'), 2_000);
    try { await exited; }
    finally {
      clearTimeout(kill); clearTimeout(deadline);
      try { launch.release(); } catch { /* Pruning drops a lease whose owner process has exited. */ }
      await rm(runtime.temp, { recursive: true, force: true });
    }
  })();
  const deadline = setTimeout(() => { void close(); }, SIGN_IN_TIMEOUT_MS);
  try {
    if (child.pid) launch.bindProcess(child.pid);
    child.stdin.on('error', () => { /* A write after the CLI exited; redirect() reports it. */ });
    child.on('error', error => { spawnError = (error as NodeJS.ErrnoException).code === 'ENOENT' ? new Error(ANTIGRAVITY_MISSING) : error; });
    child.stderr.setEncoding('utf8'); child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-16_384); });
    const lines = createInterface({ input: child.stdout });
    let url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Sign-in did not offer a Google link.')), URL_TIMEOUT_MS);
      lines.on('line', line => {
        const candidate = line.trim();
        if (!candidate.startsWith('https://accounts.google.com/')) return;
        try { resolve(consentUrl(candidate).href); clearTimeout(timer); } catch { /* Not this flow's link. */ }
      });
      void exited.then(code => { clearTimeout(timer); reject(spawnError ?? new Error(`Sign-in exited (code ${code}) before it offered a Google link.`)); });
    });
    const completion = exited.then(async code => {
      url = '';
      if (code !== 0) throw new Error('Google sign-in did not complete. Start a new sign-in.');
    }).finally(close);
    void completion.catch(() => {});
    let submitted = false;
    return {
      get url() { return url; }, completion,
      async redirect(value) {
        if (submitted) throw new Error('The code has already been submitted. Check sign-in status.');
        const response = antigravityLoginResponse(url, value);
        submitted = true;
        // The CLI may already have closed its input or exited: fail this sign-in, not the cockpit.
        await new Promise<void>((resolve, reject) => {
          if (!child.stdin.writable) { reject(new Error('The sign-in has ended. Start a new sign-in.')); return; }
          child.stdin.end(`${response}\n`, (error?: Error | null) => error ? reject(new Error('The sign-in has ended. Start a new sign-in.')) : resolve());
        });
      },
      close: async () => { url = ''; await close(); },
    };
  } catch (error) {
    await close();
    console.error('Antigravity personal sign-in start failed:', redactBrowserSignInDetails(inspect(error)), {
      code: child.exitCode, signal: child.signalCode, stderr: redactBrowserSignInDetails(stderr),
    });
    const line = redactBrowserSignInDetails(stderr).split(/\r?\n/).find(text => text.trim());
    throw new BrowserSignInStartError(`Antigravity personal sign-in could not start. ${error instanceof Error ? error.message : String(error)}${line ? ` ${line.trim()}` : ''}`);
  }
}
