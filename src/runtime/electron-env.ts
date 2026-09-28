/** `ELECTRON_RUN_AS_NODE` is for ClikCode's own process, never the programs
 * it starts.
 *
 * With no Node.js installed, the VS Code extension runs ClikCode on VS Code's
 * own Electron with ELECTRON_RUN_AS_NODE=1 (packages/vscode/src/runtime.ts).
 * That process needs the variable to start itself again (the session worker,
 * the local-model supervisor: both `process.execPath`), so it stays in
 * ClikCode's own environment. But inherited as it was, it reached every
 * vendor CLI and every shell a turn ran -- and any Electron app started from
 * one of those (`code --wait` as $EDITOR, an Electron dev build) came up as a
 * bare Node instead of itself.
 *
 * So everything ClikCode spawns that is not itself gets an environment
 * without it: harness/transport/spawn.ts applies this to every vendor CLI,
 * shell, MCP server and tool process, and the few direct spawns of something
 * that could be (or could launch) an Electron app do the same. */

const VARIABLE = 'ELECTRON_RUN_AS_NODE';

/** The environment for a child running `command`: `environment` (default:
 * this process's), minus ELECTRON_RUN_AS_NODE unless the child is this very
 * executable. Returns `environment` itself when there is nothing to remove. */
export function childEnvironment(
  command: string, environment: NodeJS.ProcessEnv = process.env, self: string = process.execPath,
): NodeJS.ProcessEnv {
  if (command === self || environment[VARIABLE] === undefined) return environment;
  const { [VARIABLE]: _dropped, ...rest } = environment;
  return rest;
}
