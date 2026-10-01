import { changed } from './line-diff.test-support.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { matchGlob } from './glob-match.js';
import { diffLines, eventDiff } from './line-diff.js';
import { validateAgainstSchema } from './schema-validate.js';
import {
  capHeadTail, ConfinementError, eventOutputPreview, readDenyReason, redactSecrets, resolvePath,
  scrubEnvironment, toolOutputDir, writeDenyReason, type PathScope,
} from './security.js';

let root: string;
let scope: PathScope;

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'gh-sec-')));
  scope = { cwd: path.join(root, 'work'), addDirs: [path.join(root, 'extra')], stateDir: path.join(root, 'home', '.clikcode-state'), homeDir: path.join(root, 'home') };
  await Promise.all([scope.cwd, scope.addDirs[0], scope.stateDir, path.join(root, 'outside'), path.join(scope.homeDir, '.ssh')].map((dir) => fs.mkdir(dir, { recursive: true })));
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

describe('path confinement', () => {
  it('accepts workspace and added directories, including files that do not exist yet', () => {
    // resolvePath + .confined is what production actually checks, in all six
    // places that enforce confinement; it is asserted directly here rather
    // than through a wrapper nothing shipped.
    expect(resolvePath('src/new/file.ts', scope).real).toBe(path.join(scope.cwd, 'src/new/file.ts'));
    expect(resolvePath('src/new/file.ts', scope).confined).toBe(true);
    expect(resolvePath(path.join(root, 'extra', 'x.txt'), scope).root).toBe(path.join(root, 'extra'));
    expect(resolvePath(path.join(root, 'extra', 'x.txt'), scope).confined).toBe(true);
  });

  it('rejects .. traversal and absolute paths outside', () => {
    expect(resolvePath('../outside/x', scope).confined, '../outside/x').toBe(false);
    expect(resolvePath('src/../../outside/x', scope).confined, 'src/../../outside/x').toBe(false);
    expect(resolvePath('/etc/passwd', scope).confined, '/etc/passwd').toBe(false);
    expect(resolvePath('~/notes.txt', scope).confined, '~/notes.txt').toBe(false);
    // A NUL byte is rejected by resolvePath itself, before confinement is
            // even considered -- so this one is a throw, not an unconfined result.
    expect(() => resolvePath('a\0b', scope)).toThrow(ConfinementError);
    // A sibling whose name merely starts with the workspace name is outside.
    expect(resolvePath(`${scope.cwd}-evil/x`, scope).confined).toBe(false);
  });

  it('rejects a symlinked directory that escapes, even for a not-yet-existing file', async () => {
    await fs.symlink(path.join(root, 'outside'), path.join(scope.cwd, 'link'));
    const resolved = resolvePath('link/new/deep.txt', scope);
    expect(resolved.real).toBe(path.join(root, 'outside', 'new', 'deep.txt'));
    expect(resolved.confined).toBe(false);
  });

  it('rejects a file symlink and a dangling symlink that point outside', async () => {
    await fs.writeFile(path.join(root, 'outside', 'target.txt'), 'x');
    await fs.symlink(path.join(root, 'outside', 'target.txt'), path.join(scope.cwd, 'file-link'));
    await fs.symlink(path.join(root, 'outside', 'not-yet.txt'), path.join(scope.cwd, 'dangling'));
    expect(resolvePath('file-link', scope).confined).toBe(false);
    expect(resolvePath('dangling', scope).confined).toBe(false);
  });

  it('allows a symlink that stays inside', async () => {
    await fs.mkdir(path.join(scope.cwd, 'real'));
    await fs.symlink(path.join(scope.cwd, 'real'), path.join(scope.cwd, 'alias'));
    const resolved = resolvePath('alias/a.txt', scope);
    expect(resolved.real).toBe(path.join(scope.cwd, 'real', 'a.txt'));
    expect(resolved.confined).toBe(true);
  });
});

describe('deny lists', () => {
  const denied = (input: string): string | undefined => writeDenyReason(resolvePath(input, scope), scope);

  it('never writes git internals, key stores, the state dir, or permission settings', () => {
    expect(denied('.git/config')).toMatch(/\.git/);
    expect(denied('sub/.git/hooks/pre-commit')).toMatch(/\.git/);
    expect(denied('~/.ssh/authorized_keys')).toMatch(/\.ssh/);
    expect(denied('~/.gnupg/x')).toMatch(/\.gnupg/);
    expect(denied(path.join(scope.stateDir, 'sessions', 's', 'harness.jsonl'))).toMatch(/state directory/);
    expect(denied('.clikcode/settings.local.json')).toMatch(/permission settings/);
    expect(denied('~/.bashrc')).toMatch(/startup file/);
    expect(denied('~/.zshrc')).toMatch(/startup file/);
  });

  it('allows ordinary files, .gitignore, and rc-named files inside the workspace', () => {
    expect(denied('src/index.ts')).toBeUndefined();
    expect(denied('.gitignore')).toBeUndefined();
    expect(denied('.github/workflows/ci.yml')).toBeUndefined();
    expect(denied('fixtures/.bashrc')).toBeUndefined();
  });

  it('catches a symlink that lands in a denied location', async () => {
    await fs.symlink(path.join(scope.homeDir, '.ssh'), path.join(scope.cwd, 'keys'));
    expect(denied('keys/authorized_keys')).toMatch(/\.ssh/);
  });

  it('blocks reads of key stores and the state dir, except spilled tool output', () => {
    const read = (input: string): string | undefined => readDenyReason(resolvePath(input, scope), scope);
    expect(read('~/.ssh/id_ed25519')).toMatch(/\.ssh/);
    expect(read(path.join(scope.stateDir, 'credentials.json'))).toMatch(/private/);
    expect(read(path.join(toolOutputDir(scope.stateDir, 's1'), 'call.log'))).toBeUndefined();
    expect(read('src/a.ts')).toBeUndefined();
  });
});

describe('secrets and caps', () => {
  it('scrubs credential-bearing environment variables', () => {
    const scrubbed = scrubEnvironment({ PATH: '/bin', OPENAI_API_KEY: 'a', GH_TOKEN: 'b', MY_SECRET: 'c', DB_PASSWORD: 'd', CLIKCODE_URL: 'e', clikcode_x: 'f', HOME: '/h', KEYBOARD: 'us', UNSET: undefined });
    expect(scrubbed).toEqual({ PATH: '/bin', HOME: '/h', KEYBOARD: 'us' });
  });

  it('masks secret values and assignments but leaves ordinary text alone', () => {
    const pem = '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\ndef\n-----END OPENSSH PRIVATE KEY-----';
    const out = redactSecrets([
      'DATABASE_URL=postgres://user:hunter2@db.example.com/app', `SSH_PRIVATE_KEY=${pem}`, 'aws AKIAIOSFODNN7EXAMPLE',
      'gh ghp_abcdefghijklmnopqrstuvwxyz0123', 'API_TOKEN="abc def"', 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345',
      'monkey=banana', 'the keyword tokenizer is fine',
    ].join('\n'));
    for (const leaked of ['hunter2', 'abc\ndef', 'AKIAIOSFODNN7EXAMPLE', 'ghp_abcdefghijklmnopqrstuvwxyz0123', 'abc def', 'abcdefghijklmnopqrstuvwxyz012345']) expect(out).not.toContain(leaked);
    expect(out).toContain('postgres://user:[REDACTED]@db.example.com/app');
    expect(out).toContain('monkey=banana');
    expect(out).toContain('the keyword tokenizer is fine');
  });

  it('caps output to head and tail', () => {
    const big = `START${'x'.repeat(100_000)}END`;
    const capped = capHeadTail(big, 1000);
    expect(capped.truncated).toBe(true);
    expect(capped.text.startsWith('START')).toBe(true);
    expect(capped.text.endsWith('END')).toBe(true);
    expect(capped.text).toMatch(/99\d+ bytes truncated/);
    expect(Buffer.byteLength(capped.text)).toBeLessThan(1200);
    expect(capHeadTail('small').truncated).toBe(false);
  });

  it('builds bounded, masked event previews', () => {
    const preview = eventOutputPreview(`${Array.from({ length: 30 }, (_, index) => `line ${index}`).join('\n')}\nMY_TOKEN=abc123\n`)!;
    // The newest lines, the earlier ones counted rather than written as a line.
    expect(preview.outputTail).toBe(true);
    expect(preview.output.at(-1)).toBe('MY_TOKEN=[REDACTED]');
    expect(preview.output.length).toBeLessThanOrEqual(8);
    expect(preview.outputOmitted).toBe(31 - preview.output.length);
    expect(eventOutputPreview('  \n')).toBeUndefined();
  });
});

describe('glob, diff, schema', () => {
  it('matches globs', () => {
    expect(matchGlob('*.ts', 'src/deep/a.ts')).toBe(true);
    expect(matchGlob('src/**/*.ts', 'src/a.ts')).toBe(true);
    expect(matchGlob('src/**/*.ts', 'src/x/y/a.ts')).toBe(true);
    expect(matchGlob('src/**/*.ts', 'lib/a.ts')).toBe(false);
    expect(matchGlob('src/*.ts', 'src/x/a.ts')).toBe(false);
    expect(matchGlob('**/*.{json,yaml}', 'a/b/c.yaml')).toBe(true);
    expect(matchGlob('src/**', 'src/a/b')).toBe(true);
    expect(matchGlob('file?.[ch]', 'file1.c')).toBe(true);
    expect(matchGlob('file?.[!ch]', 'file1.c')).toBe(false);
    expect(matchGlob('a.ts', 'ats')).toBe(false);
  });

  it('diffs lines', () => {
    expect(diffLines('a\nb\nc\n', 'a\nB\nc\nd\n').map((op) => `${op.kind[0]}${op.line}`)).toEqual(['sa', 'rb', 'aB', 'sc', 'ad']);
    expect(changed(eventDiff('', 'x\ny'))).toEqual({ removed: [], added: ['x', 'y'] });
    // Capped with no marker line in the list: the count is the file's own.
    const added = eventDiff('', Array.from({ length: 30 }, (_, index) => `l${index}`).join('\n'));
    expect(added[0]).toMatchObject({ additions: 30, removals: 0, change: 'add' });
  });

  it('validates the schema subset', () => {
    const schema = {
      type: 'object', additionalProperties: false, required: ['path'],
      properties: { path: { type: 'string' }, mode: { type: 'string', enum: ['a', 'b'] }, n: { type: 'integer', minimum: 1 }, list: { type: 'array', items: { type: 'object', required: ['k'], properties: { k: { type: 'number' } } } } },
    };
    expect(validateAgainstSchema({ path: 'x', mode: 'a', n: 2, list: [{ k: 1.5 }] }, schema)).toEqual([]);
    expect(validateAgainstSchema({ mode: 'c', n: 0, list: [{ k: 'x' }, {}], zzz: 1 }, schema)).toEqual([
      'args.path: required property is missing', 'args.mode: must be one of "a", "b"', 'args.n: must be >= 1',
      'args.list[0].k: expected number, got string', 'args.list[1].k: required property is missing',
      'args.zzz: unknown property (allowed: path, mode, n, list)',
    ]);
    expect(validateAgainstSchema('nope', schema)).toEqual(['args: expected object, got string']);
    expect(validateAgainstSchema({ path: 'x', n: 1.5 }, schema)).toEqual(['args.n: expected integer, got number']);
  });
});
