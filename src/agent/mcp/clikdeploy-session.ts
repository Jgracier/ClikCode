/** ClikDeploy's tools in every harness session, while this machine is signed in
 * to ClikDeploy (`clikdeploy login` or `clikcode gateway login`).
 *
 * The harness is handed a stdio server, `clikcode clikdeploy-mcp-serve`
 * (commands/clikdeploy-mcp-serve.ts), which proxies the platform's search-mode
 * MCP server (`/mcp?toolmode=search`). The key never goes in the spec: the
 * proxy reads it from the sign-in config itself on every call. A spec is copied
 * into places a key must not be -- Amp's --mcp-config file, Codex's launch
 * line, the agent's own command line (claude-agent-acp passes its servers to
 * the Claude CLI inline) -- and some harnesses cannot take a remote server at
 * all. The spec carries only where the sign-in config is and which chat it is. */
import Conf from 'conf';
import { dirname } from 'node:path';
import type { McpServerSpec } from './config.js';
import { getApiKeyForUrl, getApiUrl } from '../../gateway/credentials.js';
import { stateDirectory } from '../../session/store/paths.js';

export const CLIKDEPLOY_SESSION_MCP_NAME = 'clikdeploy';
/** Where the sign-in configs are, for a proxy started under a vendor's redirected HOME or XDG directories. */
export const CLIKDEPLOY_CONFIG_DIR_ENV = 'CLIKCODE_CLIKDEPLOY_CONFIG_DIR';
export const CLIKCODE_CONFIG_DIR_ENV = 'CLIKCODE_GATEWAY_CONFIG_DIR';

export interface ClikDeployConnection { url: string; key: string; config: Conf; codeConfig: Conf }

const configAt = (projectName: string, cwd: string | undefined): Conf =>
  new Conf({ projectName, configFileMode: 0o600, ...(cwd ? { cwd } : {}) });

/** The ClikDeploy account this machine is signed in to: the `clikdeploy` CLI's
 * sign-in first, then ClikCode's Gateway sign-in. Throws when there is none. */
export function clikDeployConnection(env: NodeJS.ProcessEnv = process.env): ClikDeployConnection {
  const cli = configAt('clikdeploy', env[CLIKDEPLOY_CONFIG_DIR_ENV]);
  const code = configAt('clikcode', env[CLIKCODE_CONFIG_DIR_ENV]);
  const cliUrl = (env.CLIKDEPLOY_API_URL_OVERRIDE || env.CLIKDEPLOY_API_URL || getApiUrl(cli)).replace(/\/+$/, '');
  const config = getApiKeyForUrl(cli, cliUrl) ? cli : code;
  const url = config === cli ? cliUrl : getApiUrl(code);
  const key = getApiKeyForUrl(config, url);
  if (!key) throw new Error('Sign in to ClikDeploy with clikdeploy login or clikcode gateway login first.');
  return { url, key, config, codeConfig: code };
}

/** The stdio server that gives a harness session ClikDeploy's tools; undefined while not signed in. */
export function clikDeploySessionServer(entry: string | undefined = process.env.CLIKCODE_MCP_ENTRY || process.argv[1]): McpServerSpec | undefined {
  if (!entry) return undefined;
  let connection: ClikDeployConnection;
  try { connection = clikDeployConnection(); } catch { return undefined; }
  return {
    name: CLIKDEPLOY_SESSION_MCP_NAME, transport: 'stdio', command: process.execPath, args: [entry, 'clikdeploy-mcp-serve'],
    env: {
      CLIKCODE_WORKER_PID: String(process.pid),
      CLIKCODE_HOME: stateDirectory(),
      [CLIKDEPLOY_CONFIG_DIR_ENV]: dirname(connection.config.path),
      [CLIKCODE_CONFIG_DIR_ENV]: dirname(connection.codeConfig.path),
    },
  };
}
