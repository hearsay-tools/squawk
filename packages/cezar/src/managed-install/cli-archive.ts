import { createHash, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { cliDigestSchema, type CliManifest } from './cli-manifest.ts';

const MAX_BYTES = 512 * 1024 * 1024;

/** Redirects are refused: the validated URL is the only network destination. */
export async function downloadCli(manifest: CliManifest, path: string, fetcher = fetch): Promise<void> {
  const digest = cliDigestSchema.parse(manifest.digest);
  const expected = Buffer.from(digest.value, 'hex');
  const response = await fetcher(manifest.url, { signal: AbortSignal.timeout(180_000), redirect: 'error' });
  if (!response.ok || !response.body) throw new Error(`The CLI download failed (${response.status}).`);
  const hash = createHash(digest.algorithm);
  let bytes = 0;
  const verify = new Transform({ transform(chunk: Buffer, _encoding, done) {
    bytes += chunk.length;
    if (bytes > MAX_BYTES) return done(new Error('The CLI download is too large.'));
    hash.update(chunk);
    done(null, chunk);
  } });
  await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), verify,
    createWriteStream(path, { flags: 'wx', mode: 0o600 }));
  const actual = hash.digest();
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error(`The CLI ${digest.algorithm} checksum does not match.`);
  }
}

function tarString(header: Buffer, start: number, end: number): string {
  return header.subarray(start, end).toString('utf8').replace(/\0.*$/s, '');
}

/** Accept exactly one regular file at the declared basename. Never extract archive paths. */
function executableSize(header: Buffer, name: string): number {
  const kind = header[156];
  const sizeText = tarString(header, 124, 136).trim();
  const checksumText = tarString(header, 148, 156).trim();
  let checksum = 0;
  for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : header[i]!;
  if (tarString(header, 0, 100) !== name || tarString(header, 345, 500) !== ''
    || (kind !== 0 && kind !== 48) || !/^[0-7]+$/.test(sizeText)
    || !/^[0-7]+$/.test(checksumText) || parseInt(checksumText, 8) !== checksum) {
    throw new Error('The CLI archive must contain only its regular executable; links and paths are refused.');
  }
  const size = parseInt(sizeText, 8);
  if (size <= 0 || size > MAX_BYTES) throw new Error('The CLI executable size is invalid.');
  return size;
}

export async function extractCliArchive(archive: string, destination: string, executable: string): Promise<void> {
  const output = await open(destination, 'wx', 0o700);
  const stream = createReadStream(archive).pipe(createGunzip());
  let header = Buffer.alloc(0);
  let remaining: number | undefined;
  let total = 0;
  try {
    for await (const value of stream) {
      let chunk = Buffer.from(value as Buffer);
      total += chunk.length;
      if (total > MAX_BYTES + 1024 * 1024) throw new Error('The CLI archive is too large.');
      if (remaining === undefined) {
        const needed = 512 - header.length;
        header = Buffer.concat([header, chunk.subarray(0, needed)]);
        chunk = chunk.subarray(needed);
        if (header.length < 512) continue;
        remaining = executableSize(header, executable);
      }
      const length = Math.min(remaining, chunk.length);
      if (length) await output.writeFile(chunk.subarray(0, length));
      remaining -= length;
      // Only zero padding and end-of-archive blocks may follow the executable.
      if (chunk.subarray(length).some(byte => byte !== 0)) throw new Error('The CLI archive contains extra entries.');
    }
    if (remaining !== 0) throw new Error('The CLI archive is incomplete.');
    await output.sync();
  } finally {
    stream.destroy();
    await output.close();
  }
}
