import { defineTool } from '../tool-contract.js';

/** The pair of exit_plan_mode: the agent asks to start planning (research only,
 * no edits or commands) before a change it judges non-trivial. Reaching `run`
 * means the permission layer already obtained the user's approval. The turn
 * tells the chat (onPlanModeEnter) so plan mode survives into the next turn. */
export const enterPlanModeTool = defineTool<Record<string, never>>({
  name: 'enter_plan_mode',
  class: 'meta',
  description: 'Ask to switch to plan mode before a non-trivial change: you may then only research (read, search, fetch) until you present a plan with exit_plan_mode and the user approves it. The user is asked first.',
  parameters: { type: 'object', additionalProperties: false, properties: {} },
  label: () => 'Enter plan mode',
  async run(_args, ctx) {
    if (ctx.session.plan.active) return { output: 'Plan mode is already active.' };
    ctx.session.plan = { active: true };
    return { output: 'Plan mode is on. Research the codebase and design the approach with read-only tools; file changes and commands are disabled. When the plan is concrete, call exit_plan_mode with it.' };
  },
});
