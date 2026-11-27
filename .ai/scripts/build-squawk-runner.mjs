#!/usr/bin/env node
// Builds and publishes the `squawk-runner` Agent37 workspace template from `.ai/squeal-runner/`
// using Agent37's cloud build API (`POST /v1/template-builds` -> presigned PUT -> start -> poll).
// Uses `curl` so host `HTTPS_PROXY` authentication works without extra dependencies.
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { readTestEnvInputs } from './test-env-inputs.mjs';

const DEFAULT_API_BASE = 'https://api.agent37.com';
const DEFAULT_TEMPLATE_NAME = 'squawk-runner';
const DEFAULT_DESCRIPTION = 'Ubuntu 26.04 Squeal test runner for Squawk (node uid=1000, Git 2.53, Chrome Stable, pinned agent-browser, tini)';
const POLL_INTERVAL_MS = 3_000;
const BUILD_TIMEOUT_MS = 45 * 60 * 1_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_UPLOAD_TIMEOUT_MS = 5 * 60_000;
const PROXY_ENV_KEYS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'];

export function readDockerfileAgentBrowserVersion(dockerfileText) {
  const match = /^\s*ARG\s+AGENT_BROWSER_VERSION=([^\s#]+)/m.exec(dockerfileText);
  return match ? match[1] : null;
}

export function assertPinnedAgentBrowserMatch(repoRoot) {
  const { inputs } = readTestEnvInputs(repoRoot);
  const expected = inputs.browser.agentBrowserVersion;
  const dockerfilePath = join(repoRoot, '.ai/squeal-runner/Dockerfile');
  const dockerfile = readFileSync(dockerfilePath, 'utf8');
  const dockerPin = readDockerfileAgentBrowserVersion(dockerfile);
  if (dockerPin !== expected) {
    throw new Error(
      `.ai/squeal-runner/Dockerfile pins AGENT_BROWSER_VERSION=${dockerPin ?? '(missing)'}, `
      + `but .ai/scripts/test-env.inputs.json pins ${expected}`,
    );
  }
  return expected;
}

export function packBuildContext(contextDir, archivePath) {
  execFileSync('tar', ['--exclude-vcs', '-czf', archivePath, '-C', contextDir, '.'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return statSync(archivePath).size;
}

function isLoopbackUrl(rawUrl) {
  const host = new URL(rawUrl).hostname;
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

function formatCurlConfigValue(value) {
  if (/[\r\n\0]/.test(value)) {
    throw new Error('Invalid control character in curl configuration value');
  }
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function collectProxySecrets(env = process.env) {
  const values = [];
  for (const key of PROXY_ENV_KEYS) {
    const value = env?.[key];
    if (typeof value === 'string' && value.length > 0) values.push(value);
  }
  return values;
}

function extractUrlFragments(raw, fragments) {
  let parsed = null;
  try {
    parsed = new URL(raw);
  } catch {
    try {
      parsed = new URL(`http://${raw}`);
    } catch {
      return;
    }
  }
  if (parsed.pathname && parsed.pathname.length > 1) fragments.push(parsed.pathname);
  if (parsed.search && parsed.search.length > 1) fragments.push(parsed.search);
  for (const secret of [parsed.username, parsed.password, ...parsed.searchParams.values()]) {
    if (!secret) continue;
    if (secret.length >= 4) fragments.push(secret);
    try {
      const decoded = decodeURIComponent(secret);
      if (decoded.length >= 4) fragments.push(decoded);
    } catch {
      // Leave malformed percent-encoding as raw secret only.
    }
  }
}

function collectSecretFragments(values) {
  const fragments = [];
  for (const value of values) {
    if (typeof value !== 'string' || value.length === 0) continue;
    fragments.push(value);
    extractUrlFragments(value, fragments);
  }
  return [...new Set(fragments)].sort((a, b) => b.length - a.length);
}

function sanitizeDiagnostic(rawText, secrets, env = process.env) {
  let clean = String(rawText ?? '');
  for (const secret of collectSecretFragments([...secrets, ...collectProxySecrets(env)])) {
    clean = clean.split(secret).join('[redacted]');
  }
  clean = clean
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[redacted-url]')
    .replace(/[^\s/@:]+:[^\s/@]+@\S+/g, '[redacted-credentials]')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.slice(0, 200);
}

function runCurl({
  label,
  args,
  stdinConfig,
  secrets = [],
  maxStdoutBytes = 16 * 1024 * 1024,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  curlBin = 'curl',
  env = process.env,
}) {
  if (timeoutMs <= 0) {
    return Promise.reject(new Error(`${label} timed out`));
  }
  const maxTimeSec = String(Math.max(1, Math.ceil(timeoutMs / 1000)));
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(curlBin, ['--config', '-', '--max-time', maxTimeSec, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timer = null;
    const finish = (cb, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      cb(value);
    };
    timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(rejectPromise, new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxStdoutBytes) {
        child.kill('SIGKILL');
        finish(rejectPromise, new Error(`${label} failed: curl stdout exceeded ${maxStdoutBytes} bytes`));
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      if (stderrBytes >= 64 * 1024) return;
      const take = chunk.subarray(0, 64 * 1024 - stderrBytes);
      stderrBytes += take.length;
      stderrChunks.push(take);
    });
    child.stdin.on('error', () => {
      // Ignore EPIPE when curl exits before consuming stdin.
    });
    child.on('error', (err) => {
      finish(rejectPromise, new Error(`${label} failed: unable to start curl (${err.code ?? 'spawn_error'})`));
    });
    child.on('close', (code, signal) => {
      if (code === 0) {
        finish(resolvePromise, Buffer.concat(stdoutChunks).toString('utf8'));
        return;
      }
      const stderrText = sanitizeDiagnostic(Buffer.concat(stderrChunks).toString('utf8'), secrets, env);
      const status = signal ? `killed by ${signal}` : `exited ${code ?? 'unknown'}`;
      const detail = stderrText ? `: ${stderrText}` : '';
      finish(rejectPromise, new Error(`${label} failed (curl ${status}${detail})`));
    });
    child.stdin.end(stdinConfig);
  });
}

async function curlJson({ label, method, url, authToken, body, timeoutMs, curlBin, env }) {
  const args = ['-sS', '-X', method, '-w', '\n%{http_code}'];
  if (isLoopbackUrl(url)) args.push('--noproxy', '*');
  if (body !== undefined) {
    args.push('-H', 'Content-Type: application/json', '--data-binary', JSON.stringify(body));
  }
  const configLines = [`url = ${formatCurlConfigValue(url)}`];
  if (authToken) configLines.push(`header = ${formatCurlConfigValue(`Authorization: Bearer ${authToken}`)}`);
  const output = await runCurl({
    label,
    args,
    stdinConfig: `${configLines.join('\n')}\n`,
    secrets: authToken ? [authToken] : [],
    timeoutMs,
    curlBin,
    env,
  });
  const splitAt = output.lastIndexOf('\n');
  const status = Number(output.slice(splitAt + 1).trim());
  const rawBody = output.slice(0, splitAt);
  let parsed = null;
  if (rawBody.trim()) {
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      parsed = { raw: rawBody.slice(0, 400) };
    }
  }
  return { status, body: parsed };
}

async function uploadArchive(uploadUrl, archivePath, { timeoutMs, curlBin, env }) {
  // Presigned PUT URL is a bearer credential: pass via stdin config, send no Authorization header, and never log it.
  const args = ['--fail-with-body', '-sS', '-X', 'PUT', '-H', 'Expect:', '--data-binary', `@${archivePath}`];
  if (isLoopbackUrl(uploadUrl)) args.push('--noproxy', '*');
  await runCurl({
    label: 'PUT template build archive',
    args,
    stdinConfig: `url = ${formatCurlConfigValue(uploadUrl)}\n`,
    secrets: [uploadUrl],
    maxStdoutBytes: 4 * 1024 * 1024,
    timeoutMs,
    curlBin,
    env,
  });
}

function requireStatus(step, response, expectedStatuses) {
  if (expectedStatuses.includes(response.status)) return response.body;
  const code = response.body?.error?.code ?? response.body?.code ?? 'unknown';
  const message = response.body?.error?.message ?? response.body?.message ?? '';
  throw new Error(`${step} failed (HTTP ${response.status}, ${code})${message ? `: ${message}` : ''}`);
}

export async function publishTemplate({
  repoRoot,
  name = DEFAULT_TEMPLATE_NAME,
  description = DEFAULT_DESCRIPTION,
  apiBaseUrl = DEFAULT_API_BASE,
  authToken = process.env.AGENT37_API_KEY || 'placeholder',
  pollIntervalMs = POLL_INTERVAL_MS,
  timeoutMs = BUILD_TIMEOUT_MS,
  onLog = (chunk) => process.stdout.write(chunk),
  curlBin = 'curl',
  env = process.env,
} = {}) {
  const version = assertPinnedAgentBrowserMatch(repoRoot);
  const contextDir = join(repoRoot, '.ai/squeal-runner');
  const workDir = mkdtempSync(join(tmpdir(), 'squawk-runner-build-'));
  const archivePath = join(workDir, 'context.tar.gz');
  const requestTimeoutMs = Math.min(DEFAULT_REQUEST_TIMEOUT_MS, timeoutMs);
  const uploadTimeoutMs = Math.min(DEFAULT_UPLOAD_TIMEOUT_MS, timeoutMs);
  try {
    const sizeBytes = packBuildContext(contextDir, archivePath);
    const base = apiBaseUrl.replace(/\/$/, '');
    const created = requireStatus(
      'POST /v1/template-builds',
      await curlJson({
        label: 'POST /v1/template-builds',
        method: 'POST',
        url: `${base}/v1/template-builds`,
        authToken,
        body: { name, size_bytes: sizeBytes, description },
        timeoutMs: requestTimeoutMs,
        curlBin,
        env,
      }),
      [200, 201],
    );
    if (!created?.id || !created?.upload_url) {
      throw new Error('POST /v1/template-builds returned no id or upload_url');
    }
    await uploadArchive(created.upload_url, archivePath, { timeoutMs: uploadTimeoutMs, curlBin, env });
    requireStatus(
      `POST /v1/template-builds/${created.id}/start`,
      await curlJson({
        label: `POST /v1/template-builds/${created.id}/start`,
        method: 'POST',
        url: `${base}/v1/template-builds/${created.id}/start`,
        authToken,
        timeoutMs: requestTimeoutMs,
        curlBin,
        env,
      }),
      [200, 201, 202],
    );
    const result = await pollBuildLogs({
      base,
      buildId: created.id,
      authToken,
      pollIntervalMs,
      timeoutMs,
      onLog,
      curlBin,
      env,
    });
    return { buildId: created.id, version, template: result.template };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

async function pollBuildLogs({ base, buildId, authToken, pollIntervalMs, timeoutMs, onLog, curlBin, env }) {
  const deadline = Date.now() + timeoutMs;
  let offset = 0;
  while (true) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error(`template build ${buildId} timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    const chunk = requireStatus(
      `GET /v1/template-builds/${buildId}/logs`,
      await curlJson({
        label: `GET /v1/template-builds/${buildId}/logs`,
        method: 'GET',
        url: `${base}/v1/template-builds/${buildId}/logs?offset=${offset}`,
        authToken,
        timeoutMs: Math.min(DEFAULT_REQUEST_TIMEOUT_MS, remainingMs),
        curlBin,
        env,
      }),
      [200],
    );
    if (typeof chunk?.data === 'string' && chunk.data.length > 0) onLog(chunk.data);
    if (typeof chunk?.offset === 'number' && chunk.offset > offset) offset = chunk.offset;
    if (chunk?.status === 'succeeded') return chunk;
    if (chunk?.status === 'failed') {
      const code = chunk.error?.code ?? 'build_failed';
      const message = chunk.error?.message ?? 'unknown failure';
      throw new Error(`template build ${buildId} failed (${code}): ${message}`);
    }
    const sleepMs = Math.min(pollIntervalMs, deadline - Date.now());
    if (sleepMs <= 0) {
      throw new Error(`template build ${buildId} timed out after ${Math.round(timeoutMs / 1000)}s (status: ${chunk?.status ?? 'unknown'})`);
    }
    await delay(sleepMs);
  }
}

async function main() {
  const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const { values } = parseArgs({
    options: {
      name: { type: 'string', default: DEFAULT_TEMPLATE_NAME },
      description: { type: 'string', default: DEFAULT_DESCRIPTION },
      'api-base': { type: 'string', default: process.env.AGENT37_API_BASE || DEFAULT_API_BASE },
      'dry-run': { type: 'boolean', default: false },
    },
  });
  if (values['dry-run']) {
    const version = assertPinnedAgentBrowserMatch(repoRoot);
    const workDir = mkdtempSync(join(tmpdir(), 'squawk-runner-dry-'));
    try {
      const bytes = packBuildContext(join(repoRoot, '.ai/squeal-runner'), join(workDir, 'context.tar.gz'));
      process.stdout.write(JSON.stringify({ dryRun: true, name: values.name, agentBrowserVersion: version, sizeBytes: bytes }) + '\n');
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
    return;
  }
  const published = await publishTemplate({
    repoRoot,
    name: values.name,
    description: values.description,
    apiBaseUrl: values['api-base'],
  });
  process.stdout.write(`\nPublished template: ${JSON.stringify(published)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
