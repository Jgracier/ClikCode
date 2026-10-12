import { describe, expect, it } from 'vitest';
import { decidePermission, NO_RULES, visibleTools } from '../permissions.js';
import { sessionState } from '../session-state.js';
import { enterPlanModeTool } from './enter-plan-mode.js';
import { exitPlanModeTool } from './exit-plan-mode.js';
import { defaultTools } from './registry.js';
import type { ToolContext } from '../tool-contract.js';

const scope = { cwd: '/w', addDirs: [], stateDir: '/s', homeDir: '/h', sessionId: 's' };
const decide = (mode: 'ask' | 'auto' | 'bypass', planMode = false, hasApprover = true): string =>
  decidePermission({ tool: enterPlanModeTool, args: {}, mode, rules: NO_RULES, planMode, scope, hasApprover }).decision;

describe('the enter_plan_mode tool', () => {
  const ctx = (): ToolContext => ({ session: sessionState('/tmp/clikcode-epm', `epm-${Math.random()}`) }) as ToolContext;

  it('turns plan mode on, and exit_plan_mode turns it off again', async () => {
    const context = ctx();
    expect((await enterPlanModeTool.run({}, context)).output).toMatch(/Plan mode is on/);
    expect(context.session.plan.active).toBe(true);
    await exitPlanModeTool.run({ plan: 'p' }, context);
    expect(context.session.plan).toEqual({ active: false, approvedPlan: 'p' });
  });

  it('is a no-op while already planning', async () => {
    const context = ctx();
    context.session.plan = { active: true };
    expect((await enterPlanModeTool.run({}, context)).output).toMatch(/already active/);
  });

  it('asks the user first, except under bypass; never offered inside plan mode', () => {
    expect(decide('ask')).toBe('ask');
    expect(decide('auto')).toBe('ask');
    expect(decide('bypass')).toBe('allow');
    expect(decide('ask', false, false)).toBe('deny');
    const tools = defaultTools();
    expect(visibleTools(tools, false).map((tool) => tool.name)).toContain('enter_plan_mode');
    expect(visibleTools(tools, true).map((tool) => tool.name)).not.toContain('enter_plan_mode');
  });
});
