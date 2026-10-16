import { randomBytes, webcrypto } from 'node:crypto';
import { expect, it } from 'vitest';
import { decryptAction, encryptPacket } from './handoff-crypto.js';

it('interoperates with the phone browser AES-GCM format and authenticates each action', async () => {
  const key = randomBytes(32);
  const browserKey = await webcrypto.subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt', 'decrypt']);
  const frame = encryptPacket(key, 'session-id', 'frame', 3, Buffer.from('jpeg bytes'), { width: 400, height: 300 });
  const decoded = await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(frame.iv, 'base64url'),
    additionalData: Buffer.from('session-id:frame:3') }, browserKey, Buffer.from(frame.data, 'base64url'));
  expect(Buffer.from(decoded).toString()).toBe('jpeg bytes');
  const iv = randomBytes(12);
  const action = Buffer.from(JSON.stringify({ kind: 'click', x: 10, y: 20 }));
  const encrypted = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: Buffer.from('session-id:action:1') }, browserKey, action);
  const packet = { iv: iv.toString('base64url'), data: Buffer.from(encrypted).toString('base64url'), seq: 1 };
  expect(decryptAction(key, 'session-id', packet)).toEqual({ kind: 'click', x: 10, y: 20 });
  expect(() => decryptAction(key, 'another-session', packet)).toThrow();
});
