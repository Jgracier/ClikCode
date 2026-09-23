import type { ToolSpec } from '../model-client.js';
import type { ToolDefinition } from '../tool-contract.js';
import { bashOutputTool, bashTool, killBashTool } from './bash.js';
import { editFileTool } from './edit-file.js';
import { exitPlanModeTool } from './exit-plan-mode.js';
import { globTool } from './glob.js';
import { grepTool } from './grep.js';
import { listDirTool } from './list-dir.js';
import { multiEditTool } from './multi-edit.js';
import { readFileTool } from './read-file.js';
import { todoWriteTool } from './todo-write.js';
import { webFetchTool } from './web-fetch.js';
import { writeFileTool } from './write-file.js';

export function defaultTools(): ToolDefinition[] {
  return [
    readFileTool, listDirTool, globTool, grepTool,
    writeFileTool, editFileTool, multiEditTool,
    bashTool, bashOutputTool, killBashTool,
    webFetchTool, todoWriteTool, exitPlanModeTool,
  ];
}

/** Built-ins first, then extras. A later tool may not shadow an earlier one:
 * an MCP server must never be able to replace `bash` or `write_file`. */
export function mergeTools(base: readonly ToolDefinition[], extra: readonly ToolDefinition[] = []): ToolDefinition[] {
  const seen = new Set<string>();
  const out: ToolDefinition[] = [];
  for (const tool of [...base, ...extra]) {
    if (seen.has(tool.name)) continue;
    seen.add(tool.name);
    out.push(tool);
  }
  return out;
}

export function toolSpecs(tools: readonly ToolDefinition[]): ToolSpec[] {
  return tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }));
}
