/** AES-GCM packets shared with the phone handoff page. The 32-byte key is
 * carried in the URL fragment, which never reaches the ClikDeploy server. */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export type EncryptedPacket = { iv: string; data: string; seq: number; width?: number; height?: number };
export type PhoneAction = { kind: 'click'; x: number; y: number } | { kind: 'type'; text: string }
  | { kind: 'key'; key: string } | { kind: 'scroll'; direction: 'up' | 'down' };

export function encryptPacket(key: Buffer, id: string, kind: 'frame' | 'action', seq: number, bytes: Buffer, size?: { width: number; height: number }): EncryptedPacket {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`${id}:${kind}:${seq}`));
  const encrypted = Buffer.concat([cipher.update(bytes), cipher.final(), cipher.getAuthTag()]);
  return { seq, iv: iv.toString('base64url'), data: encrypted.toString('base64url'), ...(size ?? {}) };
}

export function decryptAction(key: Buffer, id: string, packet: EncryptedPacket): PhoneAction {
  const iv = Buffer.from(packet.iv, 'base64url');
  const data = Buffer.from(packet.data, 'base64url');
  if (iv.length !== 12 || data.length < 17) throw new Error('Invalid handoff input');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(`${id}:action:${packet.seq}`));
  decipher.setAuthTag(data.subarray(-16));
  const value = JSON.parse(Buffer.concat([decipher.update(data.subarray(0, -16)), decipher.final()]).toString('utf8')) as PhoneAction;
  if (value.kind === 'click' && Number.isFinite(value.x) && Number.isFinite(value.y) && value.x >= 0 && value.y >= 0) return value;
  if (value.kind === 'type' && typeof value.text === 'string' && value.text.length <= 1000) return value;
  if (value.kind === 'key' && ['Enter', 'Tab', 'Backspace', 'Escape'].includes(value.key)) return value;
  if (value.kind === 'scroll' && ['up', 'down'].includes(value.direction)) return value;
  throw new Error('Unsupported handoff input');
}
