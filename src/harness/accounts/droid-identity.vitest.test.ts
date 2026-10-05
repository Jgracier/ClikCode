import { describe, expect, it } from 'vitest';
import { createCipheriv, randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { droidAccountEmail, droidCredentialEmail } from './droid-identity.js';

/** Encrypt the way droid's own credential store does. */
function encrypt(plaintext: string, key: Buffer): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${data.toString('base64')}`;
}

const jwt = (claims: object): string => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
const record = (email?: string): string => JSON.stringify({
  access_token: jwt({ object: 'user', email, iss: 'https://api.workos.com', exp: 1 }), refresh_token: 'redacted', whoami: { principalKind: 'human' },
});

describe('droid account email', () => {
  it('decrypts the credential and reads the WorkOS email claim, expired or not', () => {
    const key = randomBytes(32);
    expect(droidCredentialEmail(encrypt(record('a@example.com'), key), key)).toBe('a@example.com');
    expect(droidCredentialEmail(encrypt(record(), key), key)).toBeUndefined();
    expect(droidCredentialEmail(encrypt(record('a@example.com'), key), randomBytes(32))).toBeUndefined();
    expect(droidCredentialEmail('not:encrypted', key)).toBeUndefined();
  });

  it('reads the key-file store under the profile', async () => {
    const profile = mkdtempSync(join(tmpdir(), 'clikcode-droid-identity-'));
    try {
      const key = randomBytes(32);
      mkdirSync(join(profile, '.factory'));
      writeFileSync(join(profile, '.factory', 'auth.v2.key'), key.toString('base64'));
      writeFileSync(join(profile, '.factory', 'auth.v2.file'), encrypt(record('b@example.com'), key));
      expect(await droidAccountEmail(profile)).toBe('b@example.com');
    } finally {
      rmSync(profile, { recursive: true, force: true });
    }
  });
});
