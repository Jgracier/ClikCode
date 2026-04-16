import type { ServerLike } from './server-resolver';
import { resolveServerFromList } from './server-resolver';

export interface ResolvedDeployServer<T extends ServerLike = ServerLike> {
  server: T;
  servers: T[];
  selectedBy: 'explicit' | 'single' | 'first';
}

interface ResolveDeployServerOptions {
  includeIpAddress?: boolean;
  preferFirstIfMultiple?: boolean;
}

export type DeployServerResolutionErrorCode =
  | 'NO_SERVERS'
  | 'SERVER_NOT_FOUND'
  | 'MULTIPLE_SERVERS';

export class DeployServerResolutionError extends Error {
  constructor(
    message: string,
    public readonly code: DeployServerResolutionErrorCode,
    public readonly servers: ServerLike[] = [],
    public readonly requestedServer?: string
  ) {
    super(message);
    this.name = 'DeployServerResolutionError';
  }
}

export async function resolveDeployServer<T extends ServerLike>(
  api: { getServers(): Promise<T[]> },
  requestedServer?: string,
  options: ResolveDeployServerOptions = {}
): Promise<ResolvedDeployServer<T>> {
  const servers = (await api.getServers()) || [];
  if (servers.length === 0) {
    throw new DeployServerResolutionError(
      'No servers found. Add a server first: clikdeploy servers add <name> <ip>',
      'NO_SERVERS',
      servers
    );
  }

  const includeIpAddress = options.includeIpAddress ?? false;
  const preferFirstIfMultiple = options.preferFirstIfMultiple ?? false;

  const requested = (requestedServer || '').trim();
  if (requested) {
    const server = resolveServerFromList(servers, requested, { includeIpAddress });
    if (!server) {
      throw new DeployServerResolutionError(
        `Server not found: "${requested}". Available: ${servers.map((s) => s.name || s.id).join(', ')}`,
        'SERVER_NOT_FOUND',
        servers,
        requested
      );
    }
    return { server, servers, selectedBy: 'explicit' };
  }

  if (servers.length === 1) {
    return { server: servers[0], servers, selectedBy: 'single' };
  }

  if (preferFirstIfMultiple) {
    return { server: servers[0], servers, selectedBy: 'first' };
  }

  throw new DeployServerResolutionError(
    'Multiple servers connected. Specify --server <name-or-id>.',
    'MULTIPLE_SERVERS',
    servers
  );
}

export function parseEnvVarPairs(envList?: string[]): Record<string, string> {
  const environmentVariables: Record<string, string> = {};
  for (const envStr of envList || []) {
    const [key, ...valueParts] = String(envStr).split('=');
    if (!key || valueParts.length === 0) continue;
    environmentVariables[key] = valueParts.join('=');
  }
  return environmentVariables;
}

export function deriveDockerAppName(imageName: string): string {
  const imageParts = imageName.split('/').pop()?.split(':')[0] || 'app';
  const timestamp = Date.now().toString().slice(-4);
  return `${imageParts}-${timestamp}`;
}

export function deriveGithubAppName(url: string): string {
  const trimmed = url.trim().replace(/\.git$/i, '');
  const match =
    trimmed.match(/(?:https?:\/\/(?:www\.)?github\.com\/|git@github\.com:)([^/]+)\/([^/#?]+)/i) ||
    trimmed.match(/^([^/]+)\/([^/#]+)$/);
  if (match) return match[2];
  return 'app';
}
