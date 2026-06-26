export interface ServerLike {
  id: string;
  name?: string | null;
  ipAddress?: string | null;
  serverKind?: string | null;
  placement?: string | null;
  capabilities?: string[] | null;
  restrictedCapabilities?: string[] | null;
}

interface ResolveOptions {
  includeIpAddress?: boolean;
}

function normalize(value?: string | null): string {
  return (value ?? '').trim().toLowerCase();
}

export function matchesServerIdentifier(
  server: ServerLike,
  identifier: string,
  options: ResolveOptions = {}
): boolean {
  const needle = normalize(identifier);
  if (!needle) return false;

  if (normalize(server.id) === needle) return true;
  if (normalize(server.name) === needle) return true;
  if (options.includeIpAddress && normalize(server.ipAddress) === needle) return true;
  return false;
}

export function resolveServerFromList<T extends ServerLike>(
  servers: T[],
  identifier: string,
  options: ResolveOptions = {}
): T | undefined {
  return servers.find((server) => matchesServerIdentifier(server, identifier, options));
}

export async function resolveServer<T extends ServerLike>(
  api: { getServers(): Promise<T[]> },
  identifier: string,
  options: ResolveOptions = {}
): Promise<T | undefined> {
  const servers = (await api.getServers()) || [];
  return resolveServerFromList(servers, identifier, options);
}

export async function getServerById<T extends ServerLike>(
  api: { getServers(): Promise<T[]> },
  serverId: string
): Promise<T | undefined> {
  const servers = (await api.getServers()) || [];
  return servers.find((server) => normalize(server.id) === normalize(serverId));
}
