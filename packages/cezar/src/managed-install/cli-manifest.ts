import { existsSync } from 'node:fs';
import { z } from 'zod';
import type { ManagedCliSource } from '../core/managed-cli-source.ts';

export const cliDigestSchema = z.discriminatedUnion('algorithm', [
  z.object({
    algorithm: z.literal('sha256'),
    value: z.string().regex(/^[a-fA-F0-9]{64}$/).transform(value => value.toLowerCase()),
  }),
  z.object({
    algorithm: z.literal('sha384'),
    value: z.string().regex(/^[a-fA-F0-9]{96}$/).transform(value => value.toLowerCase()),
  }),
  z.object({
    algorithm: z.literal('sha512'),
    value: z.string().regex(/^[a-fA-F0-9]{128}$/).transform(value => value.toLowerCase()),
  }),
]);
export type CliDigest = z.infer<typeof cliDigestSchema>;

export const cliManifestSchema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  url: z.string().url(),
  digest: cliDigestSchema,
});
export type CliManifest = z.infer<typeof cliManifestSchema>;

/** Deterministic 64-hex release directory id derived from a validated digest. */
export function cliReleaseId(digest: CliDigest): string {
  return cliDigestSchema.parse(digest).value.slice(0, 64);
}

export function managedCliTarget(platform = process.platform, arch = process.arch): string | null {
  const os = { darwin: 'darwin', linux: 'linux', win32: 'windows' }[platform as 'darwin' | 'linux' | 'win32'];
  const cpu = { x64: 'amd64', arm64: 'arm64' }[arch as 'x64' | 'arm64'];
  if (!os || !cpu) return null;
  const musl = platform === 'linux' && (existsSync('/lib/libc.musl-x86_64.so.1') || existsSync('/lib/libc.musl-aarch64.so.1'));
  return `${os}_${cpu}${musl ? '_musl' : ''}`;
}

export function validateDownloadUrl(source: ManagedCliSource, value: string): void {
  const url = new URL(value);
  const prefix = new URL(source.downloadUrlPrefix);
  if (url.protocol !== 'https:' || url.origin !== prefix.origin || !url.pathname.startsWith(prefix.pathname)
    || url.username || url.password || url.search || url.hash || /%|\\/.test(url.pathname)) {
    throw new Error('The CLI download URL is not allowed.');
  }
}

export async function fetchCliManifest(source: ManagedCliSource, target: string, fetcher = fetch): Promise<CliManifest> {
  const response = await fetcher(source.manifestUrl.replaceAll('{target}', target), {
    signal: AbortSignal.timeout(5_000), redirect: 'error',
  });
  if (!response.ok) throw new Error(`The CLI manifest request failed (${response.status}).`);
  const text = await response.text();
  if (text.length > 16_384) throw new Error('The CLI manifest is too large.');
  const manifest = cliManifestSchema.parse(source.parseManifest(JSON.parse(text), { target }));
  validateDownloadUrl(source, manifest.url);
  return manifest;
}
