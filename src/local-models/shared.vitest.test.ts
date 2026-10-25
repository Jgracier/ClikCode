import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error The sync script is plain JavaScript.
import { expectedFiles, SHARED_DIR, SNAPSHOT_FILE, sourcePaths, sourceRepo, splitVendored } from '../../scripts/sync-fit-lib.mjs';

const repo: string = sourceRepo();
const sourcePresent = existsSync(sourcePaths(repo).signed);
const vendored = readdirSync(SHARED_DIR as string).filter((name) => name.endsWith('.ts'));

describe('vendored fit library', () => {
  it('vendors the library files', () => {
    expect(vendored).toEqual(expect.arrayContaining(['budget.ts', 'catalog-schema.ts', 'catalog-signature.ts', 'fit.ts', 'hardware-profile.ts', 'index.ts', 'rank.ts', 'speed.ts']));
  });

  it.each(vendored)('%s still matches the hash its header records (no hand edits)', (name) => {
    const { recorded, body } = splitVendored(readFileSync(join(SHARED_DIR, name), 'utf8')) as { recorded?: string; body: string };
    expect(recorded, `${name} has no generated header; run node scripts/sync-fit-lib.mjs`).toBeDefined();
    expect(createHash('sha256').update(body).digest('hex'), `${name} was edited by hand; change ClikDeploy and run node scripts/sync-fit-lib.mjs`).toBe(recorded);
  });

  it.skipIf(!sourcePresent)('matches the ClikDeploy source (run node scripts/sync-fit-lib.mjs after changing it)', () => {
    const expected = expectedFiles(repo) as Record<string, string>;
    expect(vendored.sort()).toEqual(Object.keys(expected).sort());
    for (const [name, text] of Object.entries(expected)) expect(readFileSync(join(SHARED_DIR, name), 'utf8'), name).toBe(text);
    expect(readFileSync(SNAPSHOT_FILE, 'utf8')).toBe(readFileSync(sourcePaths(repo).signed, 'utf8'));
  });

  it.skipIf(sourcePresent)('skips the source comparison: no ClikDeploy checkout at CLIKDEPLOY_REPO', () => {
    expect(sourcePresent).toBe(false);
  });
});
