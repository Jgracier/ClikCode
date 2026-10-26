/** How much history a local model can be handed before it can answer, set by how fast it reads and not by its window.
 *
 * The cloud bounds what a conversation carries by the model's window (turn/agent-history.ts): there reading is fast, so
 * the window is the only limit. A local model's window says little about it. Its server was started with a 256K window
 * because memory allowed, and half of that is 131K tokens, which `qwen3.5-4b` reads at 300 to 50 tokens a second:
 * 25 minutes or more before the first word, measured 2026-10-26 (it had read a third of 157K tokens after nine minutes
 * and was cancelled). So the same bound is applied to what the model can read in a stated time.
 *
 * Reading slows as the context fills. The fitted slowdown in speed.ts is 1/(1 + 2.9e-5 d) on an idle integrated GPU;
 * that run, on a machine under load, went from 316 tokens/s at 2K tokens to 55 at 51K, which is 9.2e-5. The larger
 * figure is used: a budget that is a little short on an idle machine is better than one that is minutes long on a busy one. */
/** Per token of context already read: speed is the empty-context speed over (1 + this x tokens read). */
export const READING_SLOWDOWN_PER_TOKEN = 9e-5;

/** How long a cold read of the conversation a local model is given may take: the carry-in and the view the agent sends are both held to it.
 * Paid when the server starts and each time the view's cut point moves (agent/context-view.ts stableTail), not at every step. */
export const WORKING_READ_SECONDS = 120;

/** The prompt tokens a model reads in `seconds`, given its speed on an empty context.
 * Reading n tokens takes (n + k n^2 / 2) / speed, so n is the root of k/2 n^2 + n - speed x seconds. */
export function readableTokens(promptPerSecond: number, seconds: number = WORKING_READ_SECONDS): number {
  if (!(promptPerSecond > 0) || !(seconds > 0)) return 0;
  const k = READING_SLOWDOWN_PER_TOKEN;
  return Math.floor((Math.sqrt(1 + 2 * k * promptPerSecond * seconds) - 1) / k);
}

/** The budget for a local model, from its measured speed. None when it was never measured: a cold start always measures and records
 * the speed, so that is a lookup that failed, and a guessed floor would hand the agent almost no history for no reason. */
export function localReadableTokens(measuredPromptPerSecond?: number): number | undefined {
  return measuredPromptPerSecond && measuredPromptPerSecond > 0 ? readableTokens(measuredPromptPerSecond) : undefined;
}
