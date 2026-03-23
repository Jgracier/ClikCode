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

export async function resolveDeployServer<T extends ServerLike>(
  api: { getServers(): Promise<T[]> },
  requestedServer?: string,
  options: ResolveDeployServerOptions = {}
): Promise<ResolvedDeployServer<T>> {
  const servers = (await api.getServers()) || [];
  if (servers.length === 0) {
    throw new Error('No servers found. Add a server first: clikdeploy servers add <name> <ip>');
  }

  const includeIpAddress = options.includeIpAddress ?? false;
  const preferFirstIfMultiple = options.preferFirstIfMultiple ?? true;

  const requested = (requestedServer || '').trim();
  if (requested) {
    const server = resolveServerFromList(servers, requested, { includeIpAddress });
    if (!server) {
      throw new Error(
        `Server not found: ${requested}. Available: ${servers.map((s) => s.name || s.id).join(', ')}`
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

  throw new Error('Multiple servers found. Please specify --server <name-or-id>.');
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
