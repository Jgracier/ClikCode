import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeployServerResolutionError } from './deploy-normalizer';
import { emitDeployServerResolutionError, emitJson } from './structured-output';

describe('structured-output', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes json to stdout', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    emitJson({ ok: true });
    expect(write).toHaveBeenCalledWith(`${JSON.stringify({ ok: true }, null, 2)}\n`);
  });

  it('emits deploy server resolution clarification payloads', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const error = new DeployServerResolutionError('pick a server', 'MULTIPLE_SERVERS', [
      { id: 's1', name: 'prod' },
    ]);
    expect(emitDeployServerResolutionError(error, 'clikdeploy deploy')).toBe(true);
    const payload = JSON.parse(String(write.mock.calls[0]?.[0]).trim());
    expect(payload.status).toBe('clarification_required');
    expect(payload.reason).toBe('multiple_servers_connected');
    expect(payload.options.servers[0].id).toBe('s1');
  });
});
