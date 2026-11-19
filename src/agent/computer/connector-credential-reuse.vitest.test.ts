import { describe, expect, it } from 'vitest';
import { credentialNames } from './connector-credential-reuse.js';
it('reuses the family credential only for a signed definition on an AWS-owned HTTPS origin', () => {
  const names = ['aws/clikdeploy-connector-key'];
  const spec = { id: 'amazonaws-acm', auth: { signing: { scheme: 'aws-sigv4' } }, http: { baseUrl: 'https://acm.{region}.amazonaws.com' } };
  expect(credentialNames(spec.id, spec, names)).toEqual(names);
  expect(credentialNames(spec.id, { ...spec, http: { baseUrl: 'https://amazonaws.com.attacker.test' } }, names)).toEqual([]);
  expect(credentialNames('other', spec, names)).toEqual([]);
  expect(credentialNames(spec.id, { ...spec, auth: {} }, names)).toEqual([]);
});

describe('the form a saved key is connected in', () => {
  it('a basic-auth key is the password, with the username saved beside it; other auth keeps the API-key form', async () => {
    const { basicDestination } = await import('./connector-credential-reuse.js');
    expect(basicDestination('dataforseo', 'basic', ['dataforseo/key', 'dataforseo/login'])).toEqual({ to: 'clikdeploy-connection-basic', with: { integration: 'dataforseo', username: 'secret:dataforseo/login' } });
    expect(basicDestination('acme', 'basic', ['acme/key', 'acme/email'])).toEqual({ to: 'clikdeploy-connection-basic', with: { integration: 'acme', username: 'secret:acme/email' } });
    // Twilio: the key's SID is the username, saved by agents as sid, key-sid or api-key-sid.
    expect(basicDestination('twilio-api', 'basic', ['twilio-api/key', 'twilio-api/sid'])).toEqual({ to: 'clikdeploy-connection-basic', with: { integration: 'twilio-api', username: 'secret:twilio-api/sid' } });
    expect(basicDestination('twilio-x', 'basic', ['twilio-x/key', 'twilio-x/api-key-sid'])).toMatchObject({ with: { username: 'secret:twilio-x/api-key-sid' } });
    // Without a saved username nothing is sent: the API-key form is refused for basic auth.
    expect(basicDestination('acme', 'basic', ['acme/key'])).toBe('no-username');
    expect(basicDestination('acme', 'api-key', ['acme/key', 'acme/login'])).toBeUndefined();
    expect(basicDestination('acme', undefined, ['acme/key'])).toBeUndefined();
  });
});
