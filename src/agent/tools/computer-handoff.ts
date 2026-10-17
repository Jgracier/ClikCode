/** Temporarily hand ClikCode's browser to a phone without an account login. */
import { defineTool } from '../tool-contract.js';
import { computerPage } from '../computer/browser.js';
import { computerEnabled } from '../computer/settings.js';
import { runTailcatHandoff } from '../computer/tailcat-handoff.js';

export const computerHandoffTool = defineTool<Record<string, never>>({
  name: 'computer_handoff', class: 'exec',
  description: 'When a browser site needs the user to solve a CAPTCHA, MFA or sign-in from another device, give them a short-lived link to control this exact browser from their phone. No ClikDeploy or Tailscale sign-in is needed. The agent waits and resumes when the user taps Done.',
  parameters: { type: 'object', additionalProperties: false, properties: {} },
  label: () => 'Hand browser to user',
  async run(_args, ctx) {
    if (!(await computerEnabled(ctx.stateDir))) return { output: 'Computer use is off.', isError: true };
    try {
      await computerPage(ctx.stateDir);
      await runTailcatHandoff({ stateDir: ctx.stateDir, signal: ctx.signal,
        onLink: link => ctx.emitOutput?.(`Open this link on your phone to finish the browser step: ${link}\n`) });
      return { output: 'The user finished the browser step. Continue the task from the current page.' };
    } catch (error) {
      return { output: error instanceof Error ? error.message : 'The phone handoff failed.', isError: true };
    }
  },
});
