import { expect, it } from 'vitest';
import { credentialNames } from './connector-credential-reuse.js';
it('reuses the family credential only for a signed definition on an AWS-owned HTTPS origin', () => {
  const names = ['aws/clikdeploy-connector-key'];
  const spec = { id: 'amazonaws-acm', auth: { signing: { scheme: 'aws-sigv4' } }, http: { baseUrl: 'https://acm.{region}.amazonaws.com' } };
  expect(credentialNames(spec.id, spec, names)).toEqual(names);
  expect(credentialNames(spec.id, { ...spec, http: { baseUrl: 'https://amazonaws.com.attacker.test' } }, names)).toEqual([]);
  expect(credentialNames('other', spec, names)).toEqual([]);
  expect(credentialNames(spec.id, { ...spec, auth: {} }, names)).toEqual([]);
});
