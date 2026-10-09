import { describe, expect, it } from 'vitest';
import { gatewayErrorMessage } from './error-message.js';

describe('gatewayErrorMessage', () => {
  it('reads the /v1 envelope and the older bare form, and nothing else', () => {
    expect(gatewayErrorMessage({ error: { message: 'Too big', type: 'invalid_request_error' } })).toBe('Too big');
    expect(gatewayErrorMessage({ error: 'Agent not found' })).toBe('Agent not found');
    expect(gatewayErrorMessage({})).toBeUndefined();
    expect(gatewayErrorMessage(null)).toBeUndefined();
    expect(gatewayErrorMessage({ error: { message: '' } })).toBeUndefined();
  });
});
