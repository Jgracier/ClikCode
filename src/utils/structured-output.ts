import type { ServerLike } from './server-resolver';
import {
  DeployServerResolutionError,
  type DeployServerResolutionErrorCode,
} from './deploy-normalizer';

export function emitJson(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

function serverChoices(servers: ServerLike[]) {
  return servers.map((server) => {
    const serverAny = server as any;
    const name = String(server.name || '').trim();
    const id = String(server.id || '').trim();
    return {
      id,
      name: name || id,
      option: `--server \"${name || id}\"`,
      ...(server.ipAddress ? { ipAddress: String(server.ipAddress) } : {}),
      ...(serverAny?.status ? { status: String(serverAny.status) } : {}),
    };
  });
}

export function emitDeployServerResolutionError(
  error: unknown,
  command: string,
  extra?: Record<string, unknown>
): boolean {
  if (!(error instanceof DeployServerResolutionError)) return false;

  const codeToReason: Record<DeployServerResolutionErrorCode, string> = {
    NO_SERVERS: 'no_servers_connected',
    SERVER_NOT_FOUND: 'server_not_found',
    MULTIPLE_SERVERS: 'multiple_servers_connected',
  };

  emitJson({
    status: 'clarification_required',
    command,
    reason: codeToReason[error.code],
    message: error.message,
    ...(error.requestedServer ? { requested_server: error.requestedServer } : {}),
    options: {
      servers: serverChoices(error.servers || []),
      usage: `${command} --server <name-or-id>`,
    },
    ...(extra || {}),
  });
  return true;
}
