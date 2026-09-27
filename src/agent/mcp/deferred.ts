/** MCP tool schemas on demand.
 *
 * A single MCP server can bring dozens of tools; measured on a developer
 * machine, two servers brought 76 tools and ~7,900 tokens of schema, three and
 * a half times the built-in tools, sent on EVERY step. On a CPU that is well
 * over a minute of prompt reading before the first word, for tools most turns
 * never touch. So when the MCP schemas together pass a budget, they are left
 * out of the prompt: one `load_mcp_tools` tool lists each server and its tool
 * names, and loading a server (or some of its tools) adds their schemas from
 * the next step on.
 *
 * What is loaded is DERIVED from the conversation -- the loader calls and any
 * direct calls in the items -- not held in memory, so a resumed session or a
 * later turn advertises the same set without bookkeeping, and the tool list
 * stays identical from step to step (prefix caches depend on that). A deferred
 * tool the model calls without loading still runs: execution looks tools up
 * in the full set, and a bad argument answer includes the schema. */
import { defineTool, type ToolDefinition } from '../tool-contract.js';
import type { ConversationItem } from '../model-client.js';

export const LOAD_MCP_TOOLS = 'load_mcp_tools';

/** Above this many schema tokens (chars/4) the MCP tools are deferred. Below
 * it, listing them costs about what loading them would, so they are sent. */
export const DEFER_MCP_SCHEMA_TOKENS = 1_500;

/** Tool names listed per server in the loader's description; more are counted. */
const LISTED_NAMES_PER_SERVER = 80;

function schemaTokens(tools: readonly ToolDefinition[]): number {
  return tools.reduce((sum, tool) => sum + Math.ceil((tool.name.length + tool.description.length + JSON.stringify(tool.parameters).length) / 4), 0);
}

interface LoadArgs { server: string; tools?: string[] }

/** The loader for `deferred`, grouped by server in first-seen order. */
function loaderTool(deferred: readonly ToolDefinition[]): ToolDefinition {
  const servers = new Map<string, ToolDefinition[]>();
  for (const tool of deferred) {
    const server = tool.mcp!.server;
    servers.set(server, [...(servers.get(server) ?? []), tool]);
  }
  const listing = [...servers].map(([server, tools]) => {
    const names = tools.slice(0, LISTED_NAMES_PER_SERVER).map((tool) => tool.mcp!.tool);
    const more = tools.length - names.length;
    return `- ${server} (${tools.length}): ${names.join(', ')}${more > 0 ? `, and ${more} more` : ''}`;
  });
  return defineTool<LoadArgs>({
    name: LOAD_MCP_TOOLS,
    description: [
      'Make MCP server tools callable. Their schemas are left out until loaded, to save context. Load only what the task needs; pass tools to load some of a server\'s tools rather than all. Loaded tools can be called from your next step. Servers and their tools:',
      ...listing,
    ].join('\n'),
    parameters: {
      type: 'object', additionalProperties: false, required: ['server'],
      properties: {
        server: { type: 'string', enum: [...servers.keys()] },
        tools: { type: 'array', items: { type: 'string' }, description: 'Tool names from the list above. Omit to load all of the server\'s tools.' },
      },
    },
    class: 'meta',
    label: (args) => `Load ${args.server} tools`,
    run: async (args) => {
      const available = servers.get(args.server);
      if (!available) return { output: `Unknown MCP server "${args.server}". Servers: ${[...servers.keys()].join(', ')}.`, isError: true };
      const wanted = args.tools?.length ? new Set(args.tools) : undefined;
      const loaded = wanted ? available.filter((tool) => wanted.has(tool.mcp!.tool) || wanted.has(tool.name)) : available;
      if (!loaded.length) return { output: `None of those are tools of "${args.server}". Its tools: ${available.map((tool) => tool.mcp!.tool).join(', ')}.`, isError: true };
      const found = new Set(loaded.flatMap((tool) => [tool.mcp!.tool, tool.name]));
      const missing = (args.tools ?? []).filter((name) => !found.has(name));
      return {
        output: `Loaded ${loaded.length} tool(s), callable from your next step: ${loaded.map((tool) => tool.name).join(', ')}.${missing.length ? ` Not tools of "${args.server}": ${missing.join(', ')}.` : ''}`,
      };
    },
  });
}

export interface ToolExposure {
  /** Every tool that may run, the loader included. */
  all: ToolDefinition[];
  /** The subset whose schemas go to the model, given the conversation so far. */
  advertised(items: readonly ConversationItem[]): ToolDefinition[];
}

/** Decides once per turn whether MCP schemas are deferred; the answer depends
 * only on the tool set, so it is the same on every turn with the same servers. */
export function exposeTools(tools: readonly ToolDefinition[]): ToolExposure {
  const mcp = tools.filter((tool) => tool.mcp);
  if (!mcp.length || schemaTokens(mcp) <= DEFER_MCP_SCHEMA_TOKENS || tools.some((tool) => tool.name === LOAD_MCP_TOOLS)) {
    return { all: [...tools], advertised: () => [...tools] };
  }
  const loader = loaderTool(mcp);
  const deferred = new Set(mcp);
  const byServer = new Map<string, ToolDefinition[]>();
  for (const tool of mcp) byServer.set(tool.mcp!.server, [...(byServer.get(tool.mcp!.server) ?? []), tool]);
  const all = [...tools.filter((tool) => !deferred.has(tool)), loader, ...mcp];
  return {
    all,
    advertised(items) {
      const loaded = new Set<string>();
      for (const item of items) {
        if (item.type !== 'tool_call') continue;
        if (item.name !== LOAD_MCP_TOOLS) { loaded.add(item.name); continue; }
        const server = byServer.get(String(item.args.server));
        if (!server) continue;
        const wanted = Array.isArray(item.args.tools) && item.args.tools.length ? new Set(item.args.tools.map(String)) : undefined;
        for (const tool of server) if (!wanted || wanted.has(tool.mcp!.tool) || wanted.has(tool.name)) loaded.add(tool.name);
      }
      // Loaded tools keep their place in `all`, so the list is a pure
      // function of what has been loaded, whatever order it happened in.
      return all.filter((tool) => !deferred.has(tool) || loaded.has(tool.name));
    },
  };
}
