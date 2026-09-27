/** MCP tools as the agent loop's own ToolDefinitions: the name the model
 * sees, the permission class, and what a result reads like. */
import { createHash } from 'node:crypto';
import { defineTool, type ToolDefinition, type ToolRunResult } from '../tool-contract.js';
import type { McpCallResult, McpContent, McpToolInfo } from './client.js';

/** The strictest limit among the model APIs this loop feeds (OpenAI and
 * Anthropic both): 64 characters of `[a-zA-Z0-9_-]`. */
const MAX_TOOL_NAME = 64;
const MAX_DESCRIPTION = 2000;
const MAX_PREVIEW_ARGS = 2000;

function cleanPart(part: string): string {
  return part.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function shortHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 8);
}

/** `mcp__<server>__<tool>`, made legal. When cleaning changed nothing and it
 * fits, it is exactly that; otherwise a hash of the ORIGINAL pair is kept on
 * the end, so two tools that clean to the same text (`a.b`, `a_b`) or share
 * a long prefix still get different names -- and the same tool gets the same
 * name every turn, which the conversation history depends on. */
export function mcpToolName(server: string, tool: string, taken: ReadonlySet<string> = new Set()): string {
  const plain = `mcp__${cleanPart(server)}__${cleanPart(tool)}`;
  const exact = plain === `mcp__${server}__${tool}`;
  if (exact && plain.length <= MAX_TOOL_NAME && !taken.has(plain)) return plain;
  const suffix = `_${shortHash(`${server}\0${tool}`)}`;
  return `${plain.slice(0, MAX_TOOL_NAME - suffix.length)}${suffix}`;
}

/** The model APIs require an object schema at the top; an MCP server may
 * omit `type` or send `$schema`, which some providers reject outright. */
export function mcpToolParameters(schema: Record<string, unknown> | undefined): Record<string, unknown> {
  const base = schema && typeof schema === 'object' && !Array.isArray(schema) ? { ...schema } : {};
  delete base.$schema;
  return { ...base, type: 'object', properties: base.properties && typeof base.properties === 'object' ? base.properties : {} };
}

function byteSize(base64: unknown): string {
  const bytes = typeof base64 === 'string' ? Math.floor(base64.length * 3 / 4) : 0;
  return bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;
}

/** Text joined as the server sent it; everything the loop cannot pass to a
 * model as text (images, audio, binary resources) summarized in a line, so
 * the model knows something came back and roughly what. */
function describeContent(item: McpContent): string {
  const entry = item as Record<string, any>;
  switch (item.type) {
    case 'text': return String(entry.text ?? '');
    case 'image':
    case 'audio': return `[${item.type}: ${entry.mimeType ?? 'unknown type'}, ${byteSize(entry.data)}]`;
    case 'resource': {
      const resource = (entry.resource ?? {}) as Record<string, unknown>;
      if (typeof resource.text === 'string') return resource.text;
      return `[resource: ${String(resource.uri ?? 'unnamed')}${resource.mimeType ? ` (${String(resource.mimeType)})` : ''}${resource.blob ? `, ${byteSize(resource.blob)}` : ''}]`;
    }
    case 'resource_link': return `[resource link: ${[entry.name, entry.uri].filter(Boolean).join(' ')}]`;
    default: return `[${String(item.type)} content]`;
  }
}

export function formatMcpResult(result: McpCallResult): ToolRunResult {
  const parts = (Array.isArray(result.content) ? result.content : []).map(describeContent).filter((part) => part.length);
  let output = parts.join('\n');
  // Structured output is only the answer when there is no text alongside
  // it; the spec asks servers that send both to make the text equivalent.
  if (!output && result.structuredContent !== undefined) output = JSON.stringify(result.structuredContent, null, 2);
  return { output: output || '(no output)', ...(result.isError ? { isError: true } : {}) };
}

export interface McpToolCaller {
  (tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult>;
}

/** One MCP tool as a ToolDefinition.
 *
 * Permission class: `read` only when the server itself says the tool is
 * read-only. Anything else is `exec`, not `write`: in this loop `write` means
 * "changes these paths", and a write with no paths is allowed outright in
 * auto mode and covered by a bare `Edit` rule. An MCP tool that sends email
 * or deploys has no path to confine, so it must ask every time -- which
 * `exec` does in every mode but bypass -- until the user saves an exact
 * `mcp__server__tool` rule for it. Plan mode hides it either way. */
export function mcpToolDefinition(server: string, info: McpToolInfo, name: string, call: McpToolCaller): ToolDefinition {
  const title = info.title ?? info.annotations?.title ?? info.name;
  const description = `${info.description?.trim() || title} (from MCP server "${server}")`;
  return defineTool<Record<string, unknown>>({
    name,
    description: description.length > MAX_DESCRIPTION ? `${description.slice(0, MAX_DESCRIPTION - 1)}…` : description,
    parameters: mcpToolParameters(info.inputSchema),
    class: info.annotations?.readOnlyHint === true ? 'read' : 'exec',
    label: () => `${server} › ${title}`,
    preview: async (args) => {
      const json = JSON.stringify(args, null, 2);
      return [`MCP server: ${server}`, `tool: ${info.name}`, 'arguments:',
        json.length > MAX_PREVIEW_ARGS ? `${json.slice(0, MAX_PREVIEW_ARGS)}\n… truncated` : json].join('\n');
    },
    run: async (args, ctx) => formatMcpResult(await call(info.name, args, ctx.signal)),
  });
}
