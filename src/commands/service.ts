/** `clikcode service` (hidden): the accounts service, ClikCode's sign-ins and
 * turns over HTTP for a platform's own agents (docs/SERVICE.md).
 *
 *   CLIKCODE_SERVICE_TOKEN  required: the bearer every route but /health checks
 *   CLIKCODE_SERVICE_PORT   default 4050
 *   CLIKCODE_SERVICE_HOST   default 127.0.0.1; 0.0.0.0 in a container
 *   CLIKCODE_HOME           where accounts, profiles and installed CLIs live
 *
 * It runs with no terminal, no display and no browser: a vendor's login is
 * shown to the caller (service/logins.ts), never opened here. */
import type Conf from 'conf';
import type { AddressInfo } from 'node:net';
import { stateDirectory } from '../session/store/paths.js';
import { lifecycle } from '../runtime/lifecycle-log.js';

export const DEFAULT_SERVICE_PORT = 4050;
/** Shorter than this is not a secret worth the name. */
const MIN_TOKEN_LENGTH = 16;

export interface ServiceSettings { token: string; port: number; host: string }

/** The settings from the environment, or why the service must not start. */
export function serviceSettings(env: NodeJS.ProcessEnv = process.env): ServiceSettings | { error: string } {
  const token = env.CLIKCODE_SERVICE_TOKEN?.trim();
  if (!token) return { error: 'CLIKCODE_SERVICE_TOKEN is not set; the service will not start without a bearer token.' };
  if (token.length < MIN_TOKEN_LENGTH) return { error: `CLIKCODE_SERVICE_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters.` };
  const rawPort = env.CLIKCODE_SERVICE_PORT?.trim();
  const port = rawPort ? Number(rawPort) : DEFAULT_SERVICE_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) return { error: `CLIKCODE_SERVICE_PORT is not a port: ${rawPort}` };
  const host = env.CLIKCODE_SERVICE_HOST?.trim() || '127.0.0.1';
  return { token, port, host };
}

export async function runService(config: Conf, signal: AbortSignal): Promise<void> {
  const settings = serviceSettings();
  if ('error' in settings) {
    process.stderr.write(`clikcode service: ${settings.error}\n`);
    process.exitCode = 2;
    return;
  }
  // Nobody sits at this machine's display: a sign-in's link goes to the caller,
  // and every vendor takes its device or pasted-code sign-in (gateway/login/url.ts).
  // A ClikDeploy remote terminal forwards a browser callback's port; nothing forwards one to this service.
  for (const name of ['DISPLAY', 'WAYLAND_DISPLAY', 'CLIKDEPLOY_REMOTE_TERMINAL']) delete process.env[name];
  const [{ createServiceServer }, { machineBackend }] = await Promise.all([import('../service/server.js'), import('../service/backend.js')]);
  const backend = machineBackend(config);
  const server = createServiceServer(backend, { token: settings.token, log: (line) => process.stderr.write(`${new Date().toISOString()} ${line}\n`) });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(settings.port, settings.host, () => { server.off('error', reject); resolve(); });
  });
  const address = server.address() as AddressInfo;
  lifecycle('service.start', { host: address.address, port: address.port });
  process.stderr.write(`clikcode service ${backend.version}${backend.commit ? ` (${backend.commit.slice(0, 12)})` : ''} listening on http://${address.address}:${address.port} · home ${stateDirectory()}\n`);
  await new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
  backend.logins.cancelAll();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  lifecycle('service.stop', {});
}
