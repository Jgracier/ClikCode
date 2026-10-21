import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { uploadRemoteImage, removeRemoteImage } from './image.js';

const originalPath = process.env.PATH;
const originalTmpdir = process.env.TMPDIR;
afterEach(() => { process.env.PATH = originalPath; process.env.TMPDIR = originalTmpdir; });

describe('a remote chat image', () => {
  it('streams the bytes through SSH into a private remote file and removes it after the turn', async () => {
    const root = mkdtempSync(join(tmpdir(), 'clikcode-image-test-'));
    const ssh = join(root, 'ssh');
    writeFileSync(ssh, '#!/bin/sh\nfor arg do command=$arg; done\nexec sh -c "$command"\n');
    chmodSync(ssh, 0o755);
    process.env.PATH = `${root}:${originalPath}`;
    process.env.TMPDIR = root;
    const bytes = Buffer.from([0, 255, 10, 13, 42]);
    const path = await uploadRemoteImage('fake-host', 'screenshot.png', bytes);
    expect(path.startsWith(root)).toBe(true);
    expect(readFileSync(path)).toEqual(bytes);
    await removeRemoteImage('fake-host', path);
    expect(existsSync(path)).toBe(false);
  });
});
