/**
 * A question a harness puts to the user mid-turn, and the answer it gets back.
 *
 * Vendors ask real questions: Claude Code's AskUserQuestion and ExitPlanMode,
 * Codex's request_user_input and MCP elicitations, Cursor's multiple-choice
 * prompts. An approval is only yes or no, so before this every one of them was
 * declined or flattened. One shape serves them all; each transport maps its
 * vendor's wire format onto it and back (form-questions.ts for the JSON-schema
 * forms ACP and Codex share).
 *
 * The user's answer is never invented here. A UI that cannot ask returns
 * `cancelled`, and the transport tells the vendor the question went unanswered.
 */

interface HarnessQuestionOption {
  label: string;
  /** Secondary text under the label. */
  description?: string;
}

export interface HarnessQuestion {
  /** The key the answer comes back under. */
  id: string;
  /** A short heading ("Auth method"). */
  header?: string;
  prompt: string;
  /** Empty: a free-text question. */
  options: readonly HarnessQuestionOption[];
  multiSelect?: boolean;
  /** Beside the options, the user may type an answer of their own. */
  allowFreeText?: boolean;
  /** Keep the answer out of history and the agent transcript. Hidden by default. */
  secret?: boolean;
  /** Display only: false shows private text while typing. Passwords stay masked. */
  maskInput?: boolean;
  /** A free-text question that starts with this text in the box, for the user to edit or leave alone (a saved value). */
  initial?: string;
  /** A free-text question typed into a pattern (`date`, `phone`, `zip`, `time`, or a pattern such as `##/##/####`): literals are inserted and jumped over as the user types, and only a complete entry is accepted. */
  format?: string;
  /** The user may leave it unanswered (shown as a Skip row). */
  optional?: boolean;
}

export interface HarnessQuestionRequest {
  title: string;
  /** A link the question is about (a URL-mode elicitation): shown, never opened for the user. */
  url?: string;
  questions: readonly HarnessQuestion[];
}

/** Each answered question's values: the option labels picked, or the text typed.
 * A question the user skipped is absent. */
export type HarnessQuestionAnswers = Readonly<Record<string, readonly string[]>>;

export type HarnessQuestionResult =
  | { kind: 'answered'; answers: HarnessQuestionAnswers }
  | { kind: 'cancelled' };

/** The asking half of the observer: returns once the user answered or cancelled.
 * `signal` aborts when the vendor withdraws the question (answered elsewhere,
 * the turn ended): the UI closes the prompt and the result is `cancelled`. */
export type HarnessQuestionAsk = (request: HarnessQuestionRequest, signal?: AbortSignal) => Promise<HarnessQuestionResult>;

export const CANCELLED: HarnessQuestionResult = { kind: 'cancelled' };

/** A transport's one entry to the channel: asks through the observer, and when
 * the observer has no question surface says so (visibly) and cancels, never hangs. */
export async function askHarnessQuestion(
  observer: { onQuestion?: HarnessQuestionAsk; onNotice?: (message: string) => void },
  request: HarnessQuestionRequest,
  signal?: AbortSignal,
  declinedNotice?: string,
): Promise<HarnessQuestionResult> {
  if (!observer.onQuestion) {
    observer.onNotice?.(declinedNotice ?? `A question was declined because this screen cannot show it: ${request.title}`);
    return CANCELLED;
  }
  if (signal?.aborted) return CANCELLED;
  try {
    return await observer.onQuestion(request, signal);
  } catch {
    // fail-open-ok: a prompt that broke is a question not answered, which the vendor handles as a cancel.
    return CANCELLED;
  }
}
