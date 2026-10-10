/** MCP resources as two agent tools, as Claude Code offers them
 * (ListMcpResourcesTool, ReadMcpResourceTool): one lists what the connected
 * servers publish, the other reads one by URI.
 *
 * Offered only when a connected server says it has resources. Both are
 * `read`: resources are the protocol's read-only data, and neither tool takes
 * a path or changes anything here. They carry no `mcp` mark -- they belong to
 * no single server -- so they are never deferred (deferred.ts). */
import { IMAGE_MIME, MAX_IMAGE_SIDE, MAX_TOOL_IMAGE_BYTES, sniffImage } from '../images.js';
import type { ImageInput } from '../model-client.js';
import { defineTool, type ToolDefinition } from '../tool-contract.js';
import type { McpResourceContents, McpResourceInfo } from './client.js';

export const LIST_MCP_RESOURCES = 'list_mcp_resources';
export const READ_MCP_RESOURCE = 'read_mcp_resource';

/** One connected server that has resources. */
export interface McpResourceSource {
  server: string;
  list(signal?: AbortSignal): Promise<McpResourceInfo[]>;
  read(uri: string, signal?: AbortSignal): Promise<McpResourceContents[]>;
}

const SEEABLE = new Set(Object.values(IMAGE_MIME));

function byteSize(base64: string): string {
  const bytes = Math.floor(base64.length * 3 / 4);
  return bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;
}

function failure(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split('\n')[0]!.slice(0, 300);
}

function resourceLine(resource: McpResourceInfo): string {
  const about = [resource.title ?? resource.name, resource.mimeType].filter(Boolean).join(', ');
  return `- ${resource.uri}${about ? ` (${about})` : ''}${resource.description?.trim() ? `: ${resource.description.trim().replace(/\s+/g, ' ')}` : ''}`;
}

export function mcpResourceTools(sources: readonly McpResourceSource[]): ToolDefinition[] {
  if (!sources.length) return [];
  const servers = sources.map((source) => source.server);
  const byName = new Map(sources.map((source) => [source.server, source]));
  const unknown = (server: string) => ({ output: `No MCP server "${server}" with resources. Servers: ${servers.join(', ')}.`, isError: true as const });

  const list = defineTool<{ server?: string }>({
    name: LIST_MCP_RESOURCES,
    class: 'read',
    description: `List the resources (files, records, documents) connected MCP servers publish, with each one's URI. Read one with ${READ_MCP_RESOURCE}. Servers with resources: ${servers.join(', ')}.`,
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { server: { type: 'string', enum: servers, description: 'Only this server\'s resources. Omit for every server.' } },
    },
    label: (args) => `List MCP resources${args.server ? ` of ${args.server}` : ''}`,
    async run(args, ctx) {
      if (args.server !== undefined && !byName.has(args.server)) return unknown(args.server);
      const chosen = args.server !== undefined ? [byName.get(args.server)!] : sources;
      // In parallel, and one server's failure is its own line, not the call's.
      const sections = await Promise.all(chosen.map(async (source) => {
        try {
          const resources = await source.list(ctx.signal);
          return { ok: true, text: `${source.server}: ${resources.length ? `${resources.length} resource${resources.length === 1 ? '' : 's'}\n${resources.map(resourceLine).join('\n')}` : 'no resources'}` };
        } catch (error) {
          return { ok: false, text: `${source.server}: could not list resources: ${failure(error)}` };
        }
      }));
      return { output: sections.map((section) => section.text).join('\n\n'), ...(sections.every((section) => !section.ok) ? { isError: true } : {}) };
    },
  });

  const read = defineTool<{ server: string; uri: string }>({
    name: READ_MCP_RESOURCE,
    class: 'read',
    description: `Read one MCP resource by its URI (from ${LIST_MCP_RESOURCES}, or one a tool result named). Text comes back as text; binary content is summarized.`,
    parameters: {
      type: 'object', additionalProperties: false, required: ['server', 'uri'],
      properties: {
        server: { type: 'string', enum: servers, description: 'The MCP server that publishes it.' },
        uri: { type: 'string', description: 'The resource URI.' },
      },
    },
    label: (args) => `Read MCP resource ${args.uri}`,
    async run(args, ctx) {
      const source = byName.get(args.server);
      if (!source) return unknown(args.server);
      let contents: McpResourceContents[];
      try {
        contents = await source.read(args.uri, ctx.signal);
      } catch (error) {
        return { output: `Could not read ${args.uri} from MCP server "${args.server}": ${failure(error)}`, isError: true };
      }
      if (!contents.length) return { output: `${args.uri} has no content.` };
      const images: ImageInput[] = [];
      const parts = contents.map((item) => {
        const uri = item.uri ?? args.uri;
        const header = contents.length > 1 ? `[${uri}${item.mimeType ? ` (${item.mimeType})` : ''}]\n` : '';
        if (typeof item.text === 'string') return `${header}${item.text}`;
        if (typeof item.blob !== 'string') return `${header}[${uri}: no content]`;
        const summary = `[binary resource ${uri}${item.mimeType ? ` (${item.mimeType})` : ''}, ${byteSize(item.blob)}]`;
        const image = seeableImage(item, ctx.acceptsImages === true);
        if (!image) return summary;
        images.push({ ...image, name: uri });
        return `${summary} attached for you to see.`;
      });
      return { output: parts.join('\n\n'), ...(images.length ? { images } : {}) };
    },
  });

  return [list, read];
}

/** A blob the model can be shown: a real PNG/JPEG/GIF/WebP, small enough,
 * for a model that sees images. Anything else stays a summary line. */
function seeableImage(item: McpResourceContents, acceptsImages: boolean): Omit<ImageInput, 'name'> | undefined {
  if (!acceptsImages || !item.blob || (item.mimeType && !SEEABLE.has(item.mimeType))) return undefined;
  const bytes = Buffer.from(item.blob, 'base64');
  if (bytes.length > MAX_TOOL_IMAGE_BYTES) return undefined;
  const sniffed = sniffImage(bytes);
  if (!sniffed || Math.max(sniffed.width ?? 0, sniffed.height ?? 0) > MAX_IMAGE_SIDE) return undefined;
  return { mimeType: sniffed.mimeType, data: item.blob };
}
