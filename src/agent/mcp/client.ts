/** One connected MCP server: the handshake, its tool list, and calls. */
import { CLIKCODE_VERSION } from '../../version.js';
import type { McpServerSpec } from './config.js';
import type { McpAuth } from './oauth.js';
import { openTransport, type McpTransport, type McpTransportHandlers } from './transport.js';

/** The revision this client is written against. A server answering with an
 * older one it supports is fine: the only methods used here have not changed
 * shape since the first revision. */
export const MCP_PROTOCOL_VERSION = '2025-06-18';

export interface McpToolInfo {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; title?: string; [key: string]: unknown };
}

export type McpContent =
  | { type: 'text'; text: string }
  | { type: 'image' | 'audio'; data?: string; mimeType?: string }
  | { type: 'resource'; resource: { uri?: string; mimeType?: string; text?: string; blob?: string } }
  | { type: 'resource_link'; uri?: string; name?: string; mimeType?: string }
  | { type: string; [key: string]: unknown };

export interface McpResourceInfo {
  uri: string;
  name?: string;
  title?: string;
  description?: string;
  mimeType?: string;
  size?: number;
}

/** One item of a resources/read answer: text, or base64 `blob`. */
export interface McpResourceContents { uri?: string; mimeType?: string; text?: string; blob?: string }

export interface McpCallResult {
  content?: McpContent[];
  structuredContent?: unknown;
  isError?: boolean;
}

interface ConnectOptions extends McpTransportHandlers {
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  /** An http server's OAuth credential (oauth.ts). */
  auth?: McpAuth;
}

export class McpClient {
  private constructor(
    readonly spec: McpServerSpec, private readonly transport: McpTransport, readonly serverName: string,
    /** The server said it has resources (initialize `capabilities.resources`). */
    readonly hasResources = false,
  ) {}

  /** Opens the transport and completes the handshake, or closes what it
   * opened and throws with the server's own explanation attached. */
  static async connect(spec: McpServerSpec, options: ConnectOptions & { signal?: AbortSignal }): Promise<McpClient> {
    const transport = openTransport(spec, options, options.fetchImpl, options.auth);
    // Aborted mid-start (the conversation left the agent route): the server
    // and everything it spawned go at once, not when the handshake would have
    // finished or timed out.
    const onAbort = (): void => { transport.killNow(); };
    if (options.signal?.aborted) onAbort();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const result = await transport.request('initialize', {
        protocolVersion: MCP_PROTOCOL_VERSION,
        // No roots, sampling or elicitation: this client calls tools and reads resources.
        capabilities: {},
        clientInfo: { name: 'clikcode', version: CLIKCODE_VERSION },
      }, { timeoutMs: options.timeoutMs });
      if (typeof result.protocolVersion === 'string') transport.setProtocolVersion(result.protocolVersion);
      transport.notify('notifications/initialized');
      const serverName = typeof result.serverInfo?.name === 'string' ? result.serverInfo.name : spec.name;
      const resources = result.capabilities?.resources;
      return new McpClient(spec, transport, serverName, Boolean(resources) && typeof resources === 'object');
    } catch (error) {
      const detail = transport.detail();
      await transport.close().catch(() => undefined);
      throw withDetail(error, detail);
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
    }
  }

  get closed(): boolean { return this.transport.closed; }
  detail(): string { return this.transport.detail(); }

  /** Every tool, across pages. */
  async listTools(timeoutMs: number): Promise<McpToolInfo[]> {
    return (await this.listAll('tools/list', 'tools', { timeoutMs }))
      .filter((tool): tool is McpToolInfo => typeof tool?.name === 'string');
  }

  /** Every resource, across pages. */
  async listResources(options: { timeoutMs: number; signal?: AbortSignal }): Promise<McpResourceInfo[]> {
    return (await this.listAll('resources/list', 'resources', options))
      .filter((resource): resource is McpResourceInfo => typeof resource?.uri === 'string');
  }

  async readResource(uri: string, options: { timeoutMs: number; signal?: AbortSignal }): Promise<McpResourceContents[]> {
    try {
      const result = await this.transport.request('resources/read', { uri }, options);
      return Array.isArray(result.contents) ? result.contents.filter((item: unknown) => item && typeof item === 'object') : [];
    } catch (error) {
      throw withDetail(error, this.transport.detail());
    }
  }

  /** A paged list method's items. A cursor that repeats would loop forever,
   * so one seen twice ends the listing. */
  private async listAll(method: string, key: string, options: { timeoutMs: number; signal?: AbortSignal }): Promise<any[]> {
    const items: any[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await this.transport.request(method, cursor ? { cursor } : {}, options)
        .catch((error: unknown) => { throw withDetail(error, this.transport.detail()); });
      for (const item of Array.isArray(page[key]) ? page[key] : []) if (item) items.push(item);
      cursor = typeof page.nextCursor === 'string' && !seen.has(page.nextCursor) ? page.nextCursor : undefined;
      if (cursor) seen.add(cursor);
    } while (cursor);
    return items;
  }

  async callTool(name: string, args: Record<string, unknown>, options: { timeoutMs: number; signal?: AbortSignal }): Promise<McpCallResult> {
    try {
      return await this.transport.request('tools/call', { name, arguments: args }, options) as McpCallResult;
    } catch (error) {
      throw withDetail(error, this.transport.detail());
    }
  }

  close(): Promise<void> { return this.transport.close(); }
  killNow(): void { this.transport.killNow(); }
}

/** Appends what the server printed, when the error does not already say it:
 * "exited 1" is useless without the stack trace that preceded it. */
function withDetail(error: unknown, detail: string): Error {
  const base = error instanceof Error ? error : new Error(String(error));
  const tail = detail.trim().split('\n').slice(-6).join('\n').slice(-800);
  if (!tail || base.message.includes(tail)) return base;
  return Object.assign(new Error(`${base.message}\n${tail}`), { name: base.name, code: (base as { code?: unknown }).code });
}
