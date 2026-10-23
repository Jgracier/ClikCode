/** The computer tools run for a harness that is not ClikCode's own agent
 * (through the MCP server or the CLI). They run here, in the chat's worker,
 * because the worker owns the private prompt, the Secrets Manager and the
 * scrubber: the harness gets back only a scrubbed status. */
import { computerEnabled } from '../agent/computer/settings.js';
import { COMPUTER_OFF } from '../agent/computer/settings.js';
import { LoginError } from '../agent/computer/login-error.js';
import { askPrivateLogin, askPrivateSecret } from '../agent/computer/private-login-prompt.js';
import { scrubSecrets } from '../agent/computer/secret-scrubber.js';
import { hotTool } from '../agent/computer/hot-tools.js';
import { validateAgainstSchema } from '../agent/schema-validate.js';
import { computerDesktopTool } from '../agent/tools/computer.js';
import { computerWebTool } from '../agent/tools/computer-web.js';
import { clikDeployStepUpTool } from '../agent/tools/clikdeploy-step-up.js';
import type { ToolContext, ToolDefinition } from '../agent/tool-contract.js';
import type { TurnObserver } from '../turn/observer.js';

export const SHARED_COMPUTER_TOOLS: readonly ToolDefinition[] = ([computerWebTool, computerDesktopTool, clikDeployStepUpTool] as unknown as ToolDefinition[]).map(hotTool);

/** A private prompt needs a window that can show it; this call's own client cannot. */
const NO_WINDOW = 'No chat window is open to show the prompt. Open this chat in the terminal or VS Code.';

export async function runSharedComputerTool(input: {
  observer: TurnObserver; stateDir: string; homeDir: string; tool: string; args: Record<string, unknown>; signal: AbortSignal; windows: () => number;
}): Promise<{ ok: boolean; output: string }> {
  const tool = SHARED_COMPUTER_TOOLS.find(candidate => candidate.name === input.tool);
  if (!tool) return { ok: false, output: `Unknown tool "${input.tool}". Available: ${SHARED_COMPUTER_TOOLS.map(entry => entry.name).join(', ')}.` };
  try {
    if (!await computerEnabled(input.stateDir)) return { ok: false, output: COMPUTER_OFF };
    const problems = validateAgainstSchema(input.args, tool.parameters);
    if (problems.length) return { ok: false, output: `Invalid arguments: ${problems.join('; ')}` };
    const needWindow = (): void => { if (input.windows() < 2) throw new LoginError(NO_WINDOW); };
    const context: Partial<ToolContext> = {
      cwd: process.cwd(), stateDir: input.stateDir, homeDir: input.homeDir, signal: input.signal,
      requestPrivateLogin: async (site, fields, signal) => { needWindow(); return askPrivateLogin(input.observer, site, fields, signal); },
      requestPrivateSecret: async (name, hint, signal) => { needWindow(); return askPrivateSecret(input.observer, name, hint, signal); },
      emitOutput: () => undefined,
    };
    const result = await tool.run(input.args, context as ToolContext);
    return { ok: !result.isError, output: scrubSecrets(result.output) };
  } catch (error) {
    return { ok: false, output: scrubSecrets(error instanceof LoginError || error instanceof Error ? error.message : String(error)) };
  }
}
