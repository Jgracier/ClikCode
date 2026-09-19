import { defineTool } from '../types.js';

interface ExitPlanModeArgs { plan: string }

/** Reaching `run` means the permission layer already obtained the user's
 * approval (it always asks for this tool while plan mode is active). */
export const exitPlanModeTool = defineTool<ExitPlanModeArgs>({
  name: 'exit_plan_mode',
  class: 'meta',
  description: 'Plan mode only. Present your implementation plan for the user to approve. Until it is approved you cannot modify files or run commands. Call this once your research is done and the plan is concrete.',
  parameters: {
    type: 'object', additionalProperties: false, required: ['plan'],
    properties: { plan: { type: 'string', description: 'The plan, in concise markdown.' } },
  },
  label: () => 'Present plan',
  async run(args, ctx) {
    if (!ctx.session.plan.active) return { output: 'Plan mode is not active; proceed with the work.' };
    ctx.session.plan = { active: false, approvedPlan: args.plan };
    return { output: 'The user approved the plan. Plan mode is off: you may now edit files and run commands. Carry out the plan.' };
  },
});
