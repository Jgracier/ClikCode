/** Specialist tools keep their full schemas and permission checks, but join
 * the prompt only when requested. The transcript is the source of loaded state. */
import { defineTool, type ToolDefinition } from './tool-contract.js';
import type { ConversationItem } from './model-client.js';

export const LOAD_TOOLS = 'load_tools';
export const CORE_TOOLS = new Set(['read_file', 'grep', 'glob', 'bash', 'apply_patch', 'edit_file', 'write_file', 'ask_user', 'skill', 'read_context', 'list_dir', 'multi_edit', 'todo_write', 'enter_plan_mode', 'exit_plan_mode', 'notebook_edit']);

export function exposeSpecialists(tools: readonly ToolDefinition[], smallWindow = false) {
  // Small windows start with retrieval and discovery; actual schemas are
  // loaded as needed, still validated and executed through the normal registry.
  const core = smallWindow ? new Set(['read_context']) : CORE_TOOLS;
  const deferred = tools.filter((tool) => !tool.mcp && !core.has(tool.name) && tool.name !== 'load_mcp_tools' && tool.name !== LOAD_TOOLS);
  if (!deferred.length) return { all: [...tools], advertised: (_items: readonly ConversationItem[]) => [...tools] };
  const names = new Set(deferred.map((tool) => tool.name));
  const loader = defineTool<{ tools: string[] }>({
    name: LOAD_TOOLS, class: 'meta',
    description: `Load specialist tool schemas before using them. All loaded tools retain their normal permissions. Available: ${deferred.map((tool) => smallWindow ? tool.name : `${tool.name}: ${tool.description.split(/\n|\. /)[0]!.slice(0, 100)}`).join('; ')}`,
    parameters: { type: 'object', additionalProperties: false, required: ['tools'], properties: { tools: { type: 'array', minItems: 1, items: { type: 'string', enum: [...names] } } } },
    label: (args) => `Load ${args.tools.join(', ')}`,
    run: async (args) => {
      const unknown = args.tools.filter((name) => !names.has(name));
      return unknown.length
        ? { output: `Unknown tools: ${unknown.join(', ')}. Available: ${[...names].join(', ')}`, isError: true }
        : { output: `Loaded ${args.tools.join(', ')}. Their schemas are available on your next step.` };
    },
  });
  const all = [...tools.filter((tool) => tool.name !== LOAD_TOOLS), loader];
  return {
    all,
    advertised(items: readonly ConversationItem[]) {
      const loaded = new Set<string>();
      for (const item of items) {
        if (item.type !== 'tool_call') continue;
        loaded.add(item.name);
        if (item.name === LOAD_TOOLS && Array.isArray(item.args.tools)) for (const name of item.args.tools) if (typeof name === 'string') loaded.add(name);
      }
      return all.filter((tool) => !names.has(tool.name) || loaded.has(tool.name));
    },
  };
}
