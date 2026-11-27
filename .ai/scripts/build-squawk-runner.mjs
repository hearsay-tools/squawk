#!/usr/bin/env node
// Builds and publishes the `squawk-runner` Agent37 workspace template from `.ai/squeal-runner/`
// using Agent37's cloud build API (`POST /v1/template-builds` -> presigned PUT -> start -> poll).
// Uses `curl` so host `HTTPS_PROXY` authentication works without extra dependencies.
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { readTestEnvInputs } from './test-env-inputs.mjs';

const execFileAsync = promisify(execFile);

const DEFAULT_API_BASE = 'https://api.agent37.com';
const DEFAULT_TEMPLATE_NAME = 'squawk-runner';
const DEFAULT_DESCRIPTION = 'Ubuntu 26.04 Squeal test runner for Squawk (node uid=1000, Git 2.53, Chrome Stable, pinned agent-browser, tini)';
const POLL_INTERVAL_MS = 3_000;
const BUILD_TIMEOUT_MS = 45 * 60 * 1_000;

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

async function curlJson({ method, url, authToken, body }) {
  const args = ['-sS', '-X', method, '-w', '\n%{http_code}'];
  if (isLoopbackUrl(url)) args.push('--noproxy', '*');
  if (authToken) args.push('-H', `Authorization: Bearer ${authToken}`);
  if (body !== undefined) {
    args.push('-H', 'Content-Type: application/json', '--data-binary', JSON.stringify(body));
  }
  args.push(url);
  const { stdout: output } = await execFileAsync('curl', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
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

async function uploadArchive(uploadUrl, archivePath) {
  // Presigned PUT URL is a bearer credential: send no Authorization header and never log it.
  const args = ['--fail-with-body', '-sS', '-X', 'PUT', '-H', 'Expect:', '--data-binary', `@${archivePath}`];
  if (isLoopbackUrl(uploadUrl)) args.push('--noproxy', '*');
  args.push(uploadUrl);
  await execFileAsync('curl', args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
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
} = {}) {
  const version = assertPinnedAgentBrowserMatch(repoRoot);
  const contextDir = join(repoRoot, '.ai/squeal-runner');
  const workDir = mkdtempSync(join(tmpdir(), 'squawk-runner-build-'));
  const archivePath = join(workDir, 'context.tar.gz');
  try {
    const sizeBytes = packBuildContext(contextDir, archivePath);
    const base = apiBaseUrl.replace(/\/$/, '');
    const created = requireStatus(
      'POST /v1/template-builds',
      await curlJson({
        method: 'POST',
        url: `${base}/v1/template-builds`,
        authToken,
        body: { name, size_bytes: sizeBytes, description },
      }),
      [200, 201],
    );
    if (!created?.id || !created?.upload_url) {
      throw new Error('POST /v1/template-builds returned no id or upload_url');
    }
    await uploadArchive(created.upload_url, archivePath);
    requireStatus(
      `POST /v1/template-builds/${created.id}/start`,
      await curlJson({
        method: 'POST',
        url: `${base}/v1/template-builds/${created.id}/start`,
        authToken,
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
    });
    return { buildId: created.id, version, template: result.template };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

async function pollBuildLogs({ base, buildId, authToken, pollIntervalMs, timeoutMs, onLog }) {
  const deadline = Date.now() + timeoutMs;
  let offset = 0;
  while (true) {
    const chunk = requireStatus(
      `GET /v1/template-builds/${buildId}/logs`,
      await curlJson({
        method: 'GET',
        url: `${base}/v1/template-builds/${buildId}/logs?offset=${offset}`,
        authToken,
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
    if (Date.now() >= deadline) {
      throw new Error(`template build ${buildId} timed out after ${Math.round(timeoutMs / 1000)}s (status: ${chunk?.status ?? 'unknown'})`);
    }
    await delay(pollIntervalMs);
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
