/** The user's other conversations, for ClikCode's own agent: the same three
 * tools vendors get over MCP (search/mcp.ts), answered in process. The chat
 * the agent is in is the one left out by default. */
import { CONVERSATION_TOOLS, type ConversationTool } from '../../search/tools.js';
import { defineTool, type ToolDefinition } from '../tool-contract.js';

const clip = (text: string, max = 48): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function label(tool: ConversationTool, args: Record<string, unknown>): string {
  if (tool.name === 'search_conversations') return `Search conversations "${clip(String(args.query ?? ''))}"`;
  if (tool.name === 'read_conversation') return `Read conversation ${clip(String(args.id ?? ''), 12)}${args.at !== undefined ? ` at ${String(args.at)}` : ''}`;
  return 'Active conversations';
}

export const conversationTools: readonly ToolDefinition[] = CONVERSATION_TOOLS.map((tool) => defineTool<Record<string, unknown>>({
  name: tool.name,
  class: 'read',
  description: tool.description,
  parameters: tool.inputSchema,
  label: (args) => label(tool, args),
  async run(args, ctx) {
    const result = await tool.run(args, { currentSessionId: ctx.sessionId });
    return { output: result.text, ...(result.isError ? { isError: true } : {}) };
  },
}));
