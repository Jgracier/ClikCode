/** Whether a running turn has stalled, by how long it has been quiet: the
 * yellow of the waiting line's spinner, and a conversation row's `stalled`
 * in the terminal and in VS Code. The threshold is Claude Code's three
 * minutes. Chalk free. */

const STALLED_AFTER_MS = 3 * 60_000;

/** Quiet this long -- no word streamed, no call started -- and a turn has
 * stalled, however young it is. A long turn that is still moving has not. */
export function turnStalled(quietMs: number): boolean {
  return quietMs >= STALLED_AFTER_MS;
}

/** Whether the waiting band's spinner shows a stall: only a conversation's
 * turn, quiet that long, and not while it waits on the user (an approval, a
 * sign-in) or is already stopping. A download, an install or a shell command
 * says how it is going by its own label, and turned yellow three minutes
 * into a download that was still moving. */
export function waitStalled(wait: { conversationTurn: boolean; onUser: boolean; cancelled: boolean; quietMs: number }): boolean {
  return wait.conversationTurn && !wait.onUser && !wait.cancelled && turnStalled(wait.quietMs);
}

/** What a private model's start says while it runs (turn-model-step.ts startingModelPhase). */
export const FINDING_SERVER_PHASE = 'Finding an available server';
export const STARTING_MODEL_PHASE = 'Starting model';

/** Finding a server and loading a model are the turn's progress, not its silence: they take minutes to
 * tens of minutes by design, and say how they are going. A turn in one is never "stalled". */
export function isModelStartPhase(phase: string | undefined): boolean {
  return phase !== undefined && (phase.startsWith(FINDING_SERVER_PHASE) || phase.startsWith(STARTING_MODEL_PHASE));
}

/** The short word for a conversation row: what the turn is waiting on. */
export function modelStartWord(phase: string): string {
  return phase.startsWith(FINDING_SERVER_PHASE) ? 'finding a server' : 'starting model';
}
