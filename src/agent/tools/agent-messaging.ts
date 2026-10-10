/** Reaching a background coding agent while it runs: a follow-up instruction,
 * and its result. See background-agents.ts. */
import { turnCancelledError } from '../cancellation.js';
import { defineTool } from '../tool-contract.js';

const DEFAULT_SECONDS = 600;
const MAX_SECONDS = 1800;

interface SendArgs { id: string; message: string }
interface WaitArgs { id?: string; seconds?: number }

export const agentSendTool = defineTool<SendArgs>({
  name: 'agent_send',
  class: 'meta',
  description: 'Send a follow-up instruction to a running background agent (started with agent background: true). It reads it before its next step, as if its user had typed it.',
  parameters: {
    type: 'object', additionalProperties: false, required: ['id', 'message'],
    properties: {
      id: { type: 'string', description: 'The agent id, e.g. "agent_1".' },
      message: { type: 'string', description: 'The instruction.' },
    },
  },
  label: (args) => `Message ${args.id}: ${args.message}`,
  async run(args, ctx) {
    if (!ctx.agents) return { output: 'There are no background agents here.', isError: true };
    return ctx.agents.send(args.id, args.message);
  },
});

export const agentWaitTool = defineTool<WaitArgs>({
  name: 'agent_wait',
  class: 'read',
  description: `Wait for a background agent to finish and get its result: the named one, or without id the next to finish. Returns early with a note after seconds (default ${DEFAULT_SECONDS}). A result you do not wait for arrives as a message anyway.`,
  parameters: {
    type: 'object', additionalProperties: false,
    properties: {
      id: { type: 'string', description: 'The agent id, e.g. "agent_1".' },
      seconds: { type: 'integer', minimum: 1, maximum: MAX_SECONDS, description: 'The longest to wait.' },
    },
  },
  label: (args) => `Wait for ${args.id ?? 'a background agent'}`,
  async run(args, ctx) {
    if (!ctx.agents) return { output: 'There are no background agents here.', isError: true };
    const seconds = Math.min(Math.max(Math.round(args.seconds ?? DEFAULT_SECONDS), 1), MAX_SECONDS);
    const result = await ctx.agents.wait(args.id, seconds, ctx.signal);
    if (ctx.signal?.aborted) throw turnCancelledError();
    return result;
  },
});
