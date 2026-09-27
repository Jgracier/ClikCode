import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { downloadVerified } from './download';

/** A file server that redirects /file to /blob (as Hugging Face redirects
 * to its CDN) and honours Range, counting what it sends. */
const BODY = Buffer.from(Array.from({ length: 200_000 }, (_, index) => index % 251));
const SHA = createHash('sha256').update(BODY).digest('hex');
let server: Server;
let base = '';
let sent = 0;
let directory = '';

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'clikcode-download-'));
  server = createServer((request, response) => {
    if (request.url === '/file') { response.writeHead(302, { location: '/blob' }); response.end(); return; }
    const range = /bytes=(\d+)-/.exec(request.headers.range ?? '');
    const start = range ? Number(range[1]) : 0;
    if (start >= BODY.length) { response.writeHead(416); response.end(); return; }
    const part = BODY.subarray(start);
    sent += part.length;
    response.writeHead(range ? 206 : 200, { 'content-length': part.length });
    response.end(part);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

afterAll(async () => {
  server.close();
  await rm(directory, { recursive: true, force: true });
});

describe('downloadVerified', () => {
  it('follows the redirect, resumes a partial file, and verifies the whole', async () => {
    const destination = join(directory, 'resume.bin');
    await writeFile(`${destination}.part`, BODY.subarray(0, 150_000));
    sent = 0;
    const seen: number[] = [];
    await downloadVerified({ url: `${base}/file`, destination, sizeBytes: BODY.length, sha256: SHA, onProgress: (progress) => seen.push(progress.bytes) });
    expect(sent).toBe(50_000);
    expect(seen.at(-1)).toBe(BODY.length);
    expect((await readFile(destination)).equals(BODY)).toBe(true);
    // A finished file is trusted by size: nothing more is fetched.
    sent = 0;
    await downloadVerified({ url: `${base}/file`, destination, sizeBytes: BODY.length, sha256: SHA });
    expect(sent).toBe(0);
  });

  it('removes a download whose hash is wrong, so it is not resumed forever', async () => {
    const destination = join(directory, 'bad.bin');
    await expect(downloadVerified({ url: `${base}/file`, destination, sizeBytes: BODY.length, sha256: '0'.repeat(64) }))
      .rejects.toThrow(/integrity check/);
    await expect(stat(`${destination}.part`)).rejects.toThrow();
    await expect(stat(destination)).rejects.toThrow();
  });
});
