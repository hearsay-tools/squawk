import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import type { RunnerBrowserSignIn } from '../../core/runner-definition.ts';
import { profileEnv } from '../../core/agent-profiles.ts';
import { productEnv } from '../../core/product-env.ts';
import { shellQuote } from '../../core/shell-env.ts';
import { AntigravityProbe } from './probe-process.ts';
import { antigravityStderr } from './stderr.ts';
import { BrowserSignInStartError, redactBrowserSignInDetails } from '../../core/browser-sign-in-error.ts';
import { AcpRpcError } from '../acp/transport.ts';

// No OAuth value is written by the helper. It forwards the browser argument to memory only.
const helperSource = `const url = process.argv[2];
fetch(process.env.SQUAWK_AGY_BROWSER_CAPTURE, {method:'POST',body:url,signal:AbortSignal.timeout(5000)})
 .then(r=>{if(!r.ok)process.exitCode=1}).catch(()=>{process.exitCode=1});\n`;

function consentUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'accounts.google.com' || url.username || url.password
    || !url.pathname.startsWith('/o/oauth2/') || !url.searchParams.get('state')) throw new Error('Invalid consent URL');
  callbackUrl(url.searchParams.get('redirect_uri') ?? '');
  return url;
}

function callbackUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || Number(url.port) < 1024
    || url.username || url.password || url.hash) throw new Error('Invalid loopback redirect');
  return url;
}

/** A redirect can reach only the listener named by this exact native consent flow. */
export function validateAntigravityRedirect(consent: string, value: string): URL {
  const original = consentUrl(consent);
  const target = callbackUrl(original.searchParams.get('redirect_uri')!);
  const pasted = callbackUrl(value);
  if (pasted.origin !== target.origin || pasted.pathname !== target.pathname
    || pasted.searchParams.getAll('state').length !== 1
    || pasted.searchParams.get('state') !== original.searchParams.get('state')
    || pasted.searchParams.getAll('code').length !== 1 || !pasted.searchParams.get('code')) {
    throw new Error('Paste the complete redirect URL from this sign-in window.');
  }
  return pasted;
}

export async function startAntigravitySignIn(accountHome?: string): Promise<RunnerBrowserSignIn> {
  const helperDir = await mkdtemp(join(tmpdir(), 'squawk-agy-browser-'));
  const helper = join(helperDir, 'browser.cjs');
  const nonce = randomUUID();
  let receive!: (url: string) => void;
  const captured = new Promise<string>(resolve => { receive = resolve; });
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== `/${nonce}`) { res.writeHead(404).end(); return; }
    let body = '';
    try {
      for await (const chunk of req) {
        body += String(chunk);
        if (body.length > 16_384) { res.writeHead(413).end(); return; }
      }
      receive(consentUrl(body).href); res.writeHead(204).end();
    }
    catch { res.writeHead(400).end(); }
  });
  let probe: AntigravityProbe | undefined;
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = () => cleanupPromise ??= (async () => {
    server.closeAllConnections(); server.close();
    try { await probe?.close(); }
    finally { await rm(helperDir, { recursive: true, force: true }); }
  })();
  let captureDeadline: NodeJS.Timeout | undefined;
  let phase = 'setup';
  try {
    await writeFile(helper, helperSource, { mode: 0o700 });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Browser capture is unavailable');
    probe = new AntigravityProbe(productEnv('ANTIGRAVITY_BIN') ?? 'agy', {
      ...profileEnv('antigravity', accountHome),
      BROWSER: `${shellQuote(process.execPath)} ${shellQuote(helper)} %s`,
      SSH_CONNECTION: 'squawk-browser-sign-in',
      SQUAWK_AGY_BROWSER_CAPTURE: `http://127.0.0.1:${address.port}/${nonce}`,
    }, 300_000);
    phase = 'initialize';
    await probe.acp.initialize();
    phase = 'authenticate';
    const completion = probe.acp.authenticate('oauth-personal').finally(cleanup);
    // Observe rejection immediately, even if startup is still waiting for the browser helper.
    void completion.catch(() => {});
    let url = await Promise.race([
      captured,
      completion.then(() => { throw new Error('Sign-in finished before a browser URL was offered. Check the account again.'); }),
      new Promise<never>((_, reject) => { captureDeadline = setTimeout(() => reject(new Error('Sign-in did not offer a browser URL.')), 15_000); }),
    ]);
    clearTimeout(captureDeadline);
    server.closeAllConnections(); server.close();
    let replayed = false;
    return {
      get url() { return url; }, completion: completion.finally(() => { url = ''; }),
      async redirect(value) {
        if (replayed) throw new Error('The redirect has already been submitted. Check sign-in status.');
        const target = validateAntigravityRedirect(url, value);
        replayed = true;
        try {
          const response = await fetch(target, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
          if (response.status >= 400) throw new Error('Native listener refused the redirect');
          await response.body?.cancel();
        }
        catch { throw new Error('The sign-in listener could not accept the redirect. Start a new sign-in.'); }
      },
      close: async () => { url = ''; await cleanup(); },
    };
  } catch (error) {
    clearTimeout(captureDeadline); await cleanup();
    const diagnostics = probe?.diagnostics;
    console.error('Antigravity personal sign-in start failed:', redactBrowserSignInDetails(inspect(error)), diagnostics && {
      ...diagnostics, stderr: redactBrowserSignInDetails(diagnostics.stderr),
      spawnError: diagnostics.spawnError && redactBrowserSignInDetails(inspect(diagnostics.spawnError)),
    });
    let cause = `${phase}: ${error instanceof Error ? error.message : String(error)}`;
    const transportClosed = error instanceof Error && error.message === 'ACP input/output transport closed';
    if (!(error instanceof AcpRpcError) && diagnostics && (diagnostics.code !== null && (diagnostics.code !== 0 || transportClosed) || diagnostics.signal)) {
      const line = redactBrowserSignInDetails(antigravityStderr(diagnostics.stderr)).split(/\r?\n/).find(line => line.trim());
      cause = `Agent exited (${diagnostics.signal ?? `code ${diagnostics.code}`})${line ? `: ${line.trim()}` : ''}`;
    }
    throw new BrowserSignInStartError(`Antigravity personal sign-in could not start. ${cause}`, { cause: error });
  }
}
