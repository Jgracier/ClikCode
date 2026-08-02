import { describe, expect, it } from 'vitest';
import {
  getServerById,
  matchesServerIdentifier,
  resolveServer,
  resolveServerFromList,
} from './server-resolver.js';

describe('server-resolver', () => {
  const servers = [
    { id: 'srv-1', name: 'Prod', ipAddress: '10.0.0.1' },
    { id: 'srv-2', name: 'Staging', ipAddress: '10.0.0.2' },
  ];

  it('matches by id, name, and optional ip', () => {
    expect(matchesServerIdentifier(servers[0]!, 'srv-1')).toBe(true);
    expect(matchesServerIdentifier(servers[0]!, 'prod')).toBe(true);
    expect(matchesServerIdentifier(servers[0]!, '10.0.0.1', { includeIpAddress: true })).toBe(true);
    expect(matchesServerIdentifier(servers[0]!, '10.0.0.2')).toBe(false);
    expect(matchesServerIdentifier(servers[0]!, '')).toBe(false);
  });

  it('resolves from list', () => {
    expect(resolveServerFromList(servers, 'staging')?.id).toBe('srv-2');
    expect(resolveServerFromList(servers, 'missing')).toBeUndefined();
  });

  it('resolves via api helpers', async () => {
    const api = { getServers: async () => servers };
    expect((await resolveServer(api, 'prod'))?.id).toBe('srv-1');
    expect(await getServerById(api, 'srv-2')).toMatchObject({ name: 'Staging' });
    expect(await getServerById(api, 'missing')).toBeUndefined();
  });
});
