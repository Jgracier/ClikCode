/** The computer tools pick up a rebuilt ClikCode without restarting the chat.
 *
 * Their code is also built as `computer-tools.js` next to the program. Each call checks that file's
 * time and, when it changed, loads the new copy and runs the call there; the chat keeps its worker,
 * its history and its open tab. Only the tool descriptions and argument lists the model was given at
 * the start of the chat stay as they were: a new argument needs a new chat, new behaviour does not.
 * Without the file (tests, a source checkout) the tools in the program run as they are. */
import { stat } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ToolDefinition } from '../tool-contract.js';

type Loaded = { mtime: number; tools: Map<string, ToolDefinition> | undefined; failure?: string };
let loaded: Loaded | undefined;

async function latest(): Promise<Map<string, ToolDefinition> | undefined> {
  let file: string;
  try { file = fileURLToPath(new URL('./computer-tools.js', import.meta.url)); } catch { return undefined; }
  let mtime: number;
  try { mtime = (await stat(file)).mtimeMs; } catch { return undefined; }
  if (loaded?.mtime === mtime) return loaded.tools;
  try {
    const module = await import(`${pathToFileURL(file).href}?v=${mtime}`) as { computerToolSet?: ToolDefinition[] };
    loaded = { mtime, tools: new Map((module.computerToolSet ?? []).map(tool => [tool.name, tool])) };
  } catch (error) {
    // A broken build must not take the tools down: run the copy in the program, and look again only after the next build.
    const failure = error instanceof Error ? error.message : String(error);
    loaded = { mtime, tools: undefined, failure };
    process.stderr.write(`computer tools: could not load the rebuilt copy (${failure})\n`);
  }
  return loaded.tools;
}

export function hotTool<T extends ToolDefinition>(tool: T): T {
  return { ...tool, run: async (args: never, context: never) => {
    const rebuilt = (await latest())?.get(tool.name);
    const result = await (rebuilt ?? tool).run(args, context);
    // Said once per broken build, in the result, so a build that did not load is never mistaken for one that did.
    if (!rebuilt && loaded?.failure && !told.has(loaded.mtime)) { told.add(loaded.mtime); return { ...result, output: `[The rebuilt computer tools did not load (${loaded.failure.slice(0, 200)}); this ran the copy built into the program.]\n${result.output}` }; }
    return result;
  } } as T;
}

const told = new Set<number>();
