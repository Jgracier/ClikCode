import { describe, expect, it } from 'vitest';
import {
  DeployServerResolutionError,
  deriveDockerAppName,
  deriveGithubAppName,
  parseEnvVarPairs,
  resolveDeployServer,
} from './deploy-normalizer';

describe('deploy-normalizer', () => {
  it('parses env var pairs', () => {
    expect(parseEnvVarPairs(['A=1', 'B=a=b'])).toEqual({ A: '1', B: 'a=b' });
    expect(parseEnvVarPairs(['invalid'])).toEqual({});
  });

  it('derives docker and github app names', () => {
    expect(deriveDockerAppName('library/nginx:alpine')).toBe('nginx');
    expect(deriveGithubAppName('https://github.com/Org/My-App.git')).toBe('org-my-app');
    expect(deriveGithubAppName('bad-url')).toBe('app');
    expect(deriveGithubAppName('https://github.com/!!!/!!!')).toBe('app');
    expect(deriveGithubAppName('owner/repo')).toBe('owner-repo');
  });

  it('resolves deploy server selection', async () => {
    const api = {
      getServers: async () => [{ id: '1', name: 'A' }],
    };
    const single = await resolveDeployServer(api);
    expect(single.selectedBy).toBe('single');

    const multiApi = {
      getServers: async () => [
        { id: '1', name: 'A' },
        { id: '2', name: 'B' },
      ],
    };
    await expect(resolveDeployServer(multiApi)).rejects.toMatchObject({ code: 'MULTIPLE_SERVERS' });
    const first = await resolveDeployServer(multiApi, undefined, { preferFirstIfMultiple: true });
    expect(first.selectedBy).toBe('first');

    const explicit = await resolveDeployServer(multiApi, 'b');
    expect(explicit.server.id).toBe('2');

    await expect(resolveDeployServer({ getServers: async () => [] })).rejects.toMatchObject({
      code: 'NO_SERVERS',
    });
    await expect(resolveDeployServer(multiApi, 'missing')).rejects.toBeInstanceOf(
      DeployServerResolutionError
    );
  });
});
