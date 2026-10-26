import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import { describeDownloads, downloadsDir, freeName, listDownloads, safeFileName } from './downloads.js';

it('makes a file name safe on every operating system', () => {
  expect(safeFileName('report.pdf')).toBe('report.pdf');
  expect(safeFileName('../../etc/passwd')).not.toMatch(/[\\/]/);
  expect(safeFileName('..\\..\\x.txt')).not.toMatch(/[\\/]/);
  expect(safeFileName('.bashrc')).toBe('_bashrc');
  expect(safeFileName('a:b*c?.txt')).toBe('a_b_c_.txt');
  expect(safeFileName('con.txt')).toBe('_con.txt');
  expect(safeFileName('')).toBe('download');
  expect(safeFileName('x'.repeat(300) + '.csv').length).toBeLessThanOrEqual(120);
  expect(safeFileName('x'.repeat(300) + '.csv').endsWith('.csv')).toBe(true);
});

it('keeps a chat\'s folder inside the downloads folder', () => {
  const dir = downloadsDir('/state', '../../evil');
  expect(dir.startsWith(join('/state', 'computer', 'downloads'))).toBe(true);
  expect(dirname(dir)).toBe(join('/state', 'computer', 'downloads'));
});

it('does not overwrite an earlier download of the same name', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'clikcode-downloads-'));
  try {
    const dir = downloadsDir(stateDir, 'c1');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'a.txt'), 'one');
    expect(await freeName(dir, 'a.txt')).toBe(join(dir, 'a (1).txt'));
    expect(await listDownloads(stateDir, 'c1')).toMatchObject([{ name: 'a.txt', size: 3 }]);
    expect(await describeDownloads(stateDir, 'c1')).toContain('a.txt (3 B');
    expect(await describeDownloads(stateDir, 'other')).toContain('No downloads yet');
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});
