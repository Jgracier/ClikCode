/** Labels for private model startup phases. */

/** What a private model's start says while it runs (turn-model-step.ts startingModelPhase). */
export const FINDING_SERVER_PHASE = 'Finding an available server';
export const STARTING_MODEL_PHASE = 'Starting model';

/** Finding a server and loading a model are the turn's progress, not its silence: they take minutes to
 * tens of minutes by design, and say how they are going. */
export function isModelStartPhase(phase: string | undefined): boolean {
  return phase !== undefined && (phase.startsWith(FINDING_SERVER_PHASE) || phase.startsWith(STARTING_MODEL_PHASE));
}

/** The short word for a conversation row: what the turn is waiting on. */
export function modelStartWord(phase: string): string {
  return phase.startsWith(FINDING_SERVER_PHASE) ? 'finding a server' : 'starting model';
}
