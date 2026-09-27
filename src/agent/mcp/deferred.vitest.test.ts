import { describe, expect, it } from 'vitest';
import type { ConversationItem } from '../model-client.js';
import { defineTool, type ToolDefinition } from '../tool-contract.js';
import { exposeTools, LOAD_MCP_TOOLS } from './deferred.js';

const builtin = defineTool({ name: 'read_file', description: 'Read a file.', parameters: { type: 'object', properties: {} }, class: 'read', label: () => 'read', run: async () => ({ output: '' }) });

function mcpTool(server: string, tool: string, descriptionChars = 400): ToolDefinition {
  return defineTool({
    name: `mcp__${server}__${tool}`, description: 'd'.repeat(descriptionChars),
    parameters: { type: 'object', properties: { id: { type: 'string' } } },
    class: 'exec', mcp: { server, tool }, label: () => tool, run: async () => ({ output: `${server}/${tool} ran` }),
  });
}

const many = (): ToolDefinition[] => [
  ...Array.from({ length: 20 }, (_, i) => mcpTool('brain', `t${i}`)),
  mcpTool('docs', 'query'),
];

const names = (tools: readonly ToolDefinition[]): string[] => tools.map((tool) => tool.name);
const call = (name: string, args: Record<string, unknown>, id = name): ConversationItem => ({ type: 'tool_call', id, name, args });

describe('deferred MCP tools', () => {
  it('sends small MCP tool sets as they are', () => {
    const exposure = exposeTools([builtin, mcpTool('docs', 'query', 100)]);
    expect(names(exposure.advertised([]))).toEqual(['read_file', 'mcp__docs__query']);
  });

  it('replaces large ones with a loader that lists every server and tool', () => {
    const exposure = exposeTools([builtin, ...many()]);
    const advertised = exposure.advertised([]);
    expect(names(advertised)).toEqual(['read_file', LOAD_MCP_TOOLS]);
    expect(advertised[1].description).toContain('- brain (20): t0, t1');
    expect(advertised[1].description).toContain('- docs (1): query');
    // Everything can still run.
    expect(exposure.all.map((tool) => tool.name)).toContain('mcp__brain__t7');
  });

  it('advertises what the conversation loaded, in a fixed order', async () => {
    const exposure = exposeTools([builtin, ...many()]);
    const loader = exposure.all.find((tool) => tool.name === LOAD_MCP_TOOLS)!;
    const result = await loader.run({ server: 'brain', tools: ['t3', 't1', 'nope'] }, {} as never);
    expect(result.output).toBe('Loaded 2 tool(s), callable from your next step: mcp__brain__t1, mcp__brain__t3. Not tools of "brain": nope.');
    const afterDocs = exposure.advertised([call(LOAD_MCP_TOOLS, { server: 'docs' }, 'a'), call(LOAD_MCP_TOOLS, { server: 'brain', tools: ['t3', 't1'] }, 'b')]);
    const reversed = exposure.advertised([call(LOAD_MCP_TOOLS, { server: 'brain', tools: ['t1', 't3'] }, 'b'), call(LOAD_MCP_TOOLS, { server: 'docs' }, 'a')]);
    expect(names(afterDocs)).toEqual(['read_file', LOAD_MCP_TOOLS, 'mcp__brain__t1', 'mcp__brain__t3', 'mcp__docs__query']);
    expect(names(reversed)).toEqual(names(afterDocs));
    // A tool the model called directly stays advertised from then on.
    expect(names(exposure.advertised([call('mcp__brain__t9', {})]))).toContain('mcp__brain__t9');
  });

  it('rejects an unknown server with the list of real ones', async () => {
    const loader = exposeTools([builtin, ...many()]).all.find((tool) => tool.name === LOAD_MCP_TOOLS)!;
    expect(await loader.run({ server: 'nope' }, {} as never)).toEqual({ output: 'Unknown MCP server "nope". Servers: brain, docs.', isError: true });
  });
});
