/** The agent re-prompts itself later. The timer lives in the worker process
 * that holds this conversation (session-state.ts scheduleWakeup): the worker is
 * kept up while one is pending, and one that stops first (shutdown, a crash)
 * tells the model next time that the wakeup never fired -- it is not durable
 * across a stopped worker, and the description says so. */
import { defineTool } from '../tool-contract.js';
import { cancelWakeups, scheduleWakeup } from '../session-state.js';

interface WakeupArgs { delay_seconds?: number; prompt?: string; reason?: string; stop?: boolean }

const MIN_WAKEUP_SECONDS = 60;
const MAX_WAKEUP_SECONDS = 3600;

export const scheduleWakeupTool = defineTool<WakeupArgs>({
  name: 'schedule_wakeup',
  class: 'exec',
  description: `Schedule a prompt to be sent back to you after a delay (${MIN_WAKEUP_SECONDS}s to ${MAX_WAKEUP_SECONDS}s; other values are clamped), then end your turn: when it fires you continue with that prompt, as a new message. Use it to check on something later, not to poll work that notifies you itself (a background shell's exit, a background agent's result and a monitor's output all arrive on their own). It is held by this conversation's worker and is lost if that worker stops before it fires (you are told next time). Call with stop: true to cancel the pending wakeups.`,
  parameters: {
    type: 'object', additionalProperties: false,
    properties: {
      delay_seconds: { type: 'integer', description: `Seconds from now (${MIN_WAKEUP_SECONDS}-${MAX_WAKEUP_SECONDS}, clamped). Required unless stop is true.` },
      prompt: { type: 'string', description: 'What to do when you wake: written for yourself, complete without this conversation\'s context. Required unless stop is true.' },
      reason: { type: 'string', description: 'One short sentence: why this delay. Shown to the user. Required unless stop is true.' },
      stop: { type: 'boolean', description: 'Cancel every pending wakeup and schedule nothing; the other fields are ignored.' },
    },
  },
  label: (args) => args.stop ? 'Cancel wakeups' : `Wake in ${args.delay_seconds ?? '?'}s: ${args.reason ?? args.prompt ?? ''}`.trim(),
  async describe(args) {
    return args.stop ? 'cancels the pending wakeups' : `re-prompts the agent in ${args.delay_seconds ?? '?'}s with: ${args.prompt ?? ''}`;
  },
  async run(args, ctx) {
    if (args.stop) {
      const cancelled = cancelWakeups(ctx.session);
      return { output: cancelled ? `Cancelled ${cancelled} pending wakeup(s).` : 'No wakeup was pending.' };
    }
    if (typeof args.delay_seconds !== 'number' || !args.prompt?.trim() || !args.reason?.trim()) {
      return { output: 'delay_seconds, prompt and reason are required unless stop is true.', isError: true };
    }
    const seconds = Math.min(Math.max(Math.round(args.delay_seconds), MIN_WAKEUP_SECONDS), MAX_WAKEUP_SECONDS);
    const wakeup = scheduleWakeup(ctx.session, { prompt: args.prompt, reason: args.reason, delayMs: seconds * 1000 });
    const clamped = seconds !== args.delay_seconds ? ` (clamped from ${args.delay_seconds}s to the ${MIN_WAKEUP_SECONDS}-${MAX_WAKEUP_SECONDS}s range)` : '';
    return { output: `Scheduled ${wakeup.id} in ${seconds}s${clamped}, at ${new Date(wakeup.at).toISOString()}. Nothing more to do this turn: end it, and the prompt arrives when it fires.` };
  },
});
