import { defineTool } from '../tool-contract.js';

interface AskUserArgs { question: string; options?: string[]; multiSelect?: boolean }

/** The question as the user reads it: numbered options, and how to answer. */
export function formatQuestion(args: AskUserArgs): string {
  const options = (args.options ?? []).map((option) => option.trim()).filter(Boolean);
  if (!options.length) return args.question.trim();
  const how = args.multiSelect ? 'Reply with the numbers you want, or in your own words.' : 'Reply with a number, or in your own words.';
  return `${args.question.trim()}\n\n${options.map((option, index) => `${index + 1}. ${option}`).join('\n')}\n\n${how}`;
}

/** Ask the user and wait for the answer. The turn ends on the question (the
 * loop, run-turn.ts); the user's next message is the answer. Works the same on
 * every surface -- the terminal, an IDE, `clikcode send` -- because it is a
 * turn boundary rather than a dialog. */
export const askUserTool = defineTool<AskUserArgs>({
  name: 'ask_user',
  class: 'meta',
  description: 'Ask the user a question when you need their decision or information to continue: a choice between approaches, a missing requirement, a preference. Give 2-6 concise options when the answer is a choice. Your turn ends on the question and their reply arrives as their next message, so ask only what you cannot reasonably decide yourself, and put everything they need to answer in the question.',
  parameters: {
    type: 'object', additionalProperties: false, required: ['question'],
    properties: {
      question: { type: 'string', description: 'The question, complete enough to answer without scrolling back.' },
      options: { type: 'array', items: { type: 'string' }, maxItems: 6, description: 'The choices, when the answer is one of a few.' },
      multiSelect: { type: 'boolean', description: 'True when more than one option may be chosen.' },
    },
  },
  label: (args) => `Ask: ${String(args.question ?? '').slice(0, 60)}`,
  async run(args, ctx) {
    if (!ctx.runSubagent) return { output: 'A sub-agent cannot ask the user. Report what you need in your result instead.', isError: true };
    if (!args.question?.trim()) return { output: 'ask_user needs a question.', isError: true };
    ctx.session.pendingQuestion = formatQuestion(args);
    return { output: 'The question is shown to the user and this turn ends on it. Their answer will be their next message; do not continue until then.' };
  },
});
