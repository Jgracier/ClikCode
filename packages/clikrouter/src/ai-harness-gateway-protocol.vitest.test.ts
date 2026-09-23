import { describe, expect, it } from 'vitest';
import { AI_HARNESS_GATEWAY_PROTOCOL, parseAiHarnessGatewayJob } from './ai-harness-gateway-protocol';

const job = () => ({
  protocol: AI_HARNESS_GATEWAY_PROTOCOL, id: 'job-1', installationId: 'device-1', issuedAt: '2026-09-16T00:00:00.000Z', expiresAt: '2026-09-16T00:01:00.000Z', nonce: 'nonce-1',
  authority: { subject: 'user-1', scopes: ['ai:chat'], expiresAt: '2026-09-16T00:01:00.000Z' }, kind: 'chat' as const,
  payload: { sessionId: 'session-1', messages: [{ role: 'user' as const, content: 'hello' }] },
});

describe('AI harness gateway job contract', () => {
  it('accepts a live narrow chat authority', () => expect(parseAiHarnessGatewayJob(job(), Date.parse('2026-09-16T00:00:00.000Z'))).toMatchObject({ id: 'job-1' }));
  it('rejects expired authority and malformed messages', () => {
    expect(parseAiHarnessGatewayJob(job(), Date.parse('2026-09-16T00:02:00.000Z'))).toBeNull();
    const malformed = job();
    malformed.payload.messages = [{ role: 'system' as never, content: 'no' }];
    expect(parseAiHarnessGatewayJob(malformed, Date.parse('2026-09-16T00:00:00.000Z'))).toBeNull();
  });
});
