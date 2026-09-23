/** Naming a conversation after what was first said in it. */

import { failoverPromptRequest } from '../../turn/failover-prompt.js';

/** A short, single-line title from a chat's first real message.
 *
 * Its own module because it is PURE -- a prompt in, a string out -- while the
 * rest of titles.ts has to ask the store where a conversation lives. The
 * vendor readers want only this half, and taking it from a module that
 * reaches back into the store registry is what made
 * registry -> vendors/claude -> titles -> registry a cycle. Splitting on that
 * line is also just what the two functions are: one formats text, the other
 * goes looking on disk. */
export function conversationTitle(prompt: string): string {
  // A rehydration prompt is ClikCode talking to the vendor, not the user
  // talking to ClikCode. Naming a session after one produced the literal
  // title "Continue the same ClikCode conversation after an account or pro…".
  const title = (failoverPromptRequest(prompt) ?? prompt).replace(/\s+/g, ' ').trim();
  return title.length > 64 ? `${title.slice(0, 63).trimEnd()}…` : title;
}
