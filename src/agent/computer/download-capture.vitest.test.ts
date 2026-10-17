import { expect, it } from 'vitest';
import { secretParts } from './download-capture.js';

it('treats the private key of a credential file as secret, and its public identifiers as readable', () => {
  const file = JSON.stringify({ type: 'service_account', project_id: 'clickdeploy-477818', private_key_id: 'a92ef41d3362f8ba630ce9d06e248537e08cc19f',
    private_key: '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----\n', client_email: 'x@p.iam.gserviceaccount.com', client_secret: 'GOCSPX-abcdefghijklmnop' });
  const parts = secretParts(file);
  expect(parts).toHaveLength(2);
  expect(parts.some(part => part.includes('BEGIN PRIVATE KEY'))).toBe(true);
  expect(parts).toContain('GOCSPX-abcdefghijklmnop');
  expect(parts.join()).not.toContain('a92ef41d3362');
  expect(parts.join()).not.toContain('clickdeploy-477818');
});

it('finds nothing in text that is not JSON', () => {
  expect(secretParts('just a key value 1234567890abcdef')).toEqual([]);
});
