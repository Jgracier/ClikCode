/** Which keys answer a pending approval, and what its header says, shared
 * by the terminal and the VS Code webview so both read and guard it alike. */

/** How long an approval ignores every key after it appears. A person typing
 * into the composer cannot stop within a frame of a prompt popping up; without
 * this the `y` of whatever word they were on approved a tool call. */
export const APPROVAL_GUARD_MS = 400;

/** What one key means to a pending approval. The rule, in full:
 *  - every key is ignored for the first APPROVAL_GUARD_MS;
 *  - Esc and Ctrl+C always deny (neither can be part of a draft);
 *  - if the composer held a draft when the approval appeared, Tab must be
 *    pressed first to focus the approval -- until then y/n/Enter are ignored,
 *    because they are exactly the characters the user is in the middle of
 *    typing;
 *  - then y/Y allows once, n/N and Enter (the default) deny;
 *  - a/A allows always, and ONLY where a rule was offered -- otherwise it is
 *    ignored rather than silently meaning "once", since a key that appears to
 *    remember an answer and does not is worse than no key at all;
 *  - t/T is "no, and tell it what to do instead", ONLY where the caller can
 *    send that text into the running turn (`canTell`) -- likewise ignored
 *    otherwise, rather than a denial that drops what was typed.
 * Nothing typed while an approval is pending ever reaches the draft. */
export function approvalKeyAction(
  key: string, elapsedMs: number, needsFocus: boolean, focused: boolean, hasRule = false, canTell = false,
): 'allow' | 'always' | 'deny' | 'tell' | 'focus' | 'ignore' {
  if (elapsedMs < APPROVAL_GUARD_MS) return 'ignore';
  if (key === '\u001b' || key === '\u0003') return 'deny';
  if (needsFocus && !focused) return key === '\t' ? 'focus' : 'ignore';
  if (key === 'y' || key === 'Y') return 'allow';
  if (hasRule && (key === 'a' || key === 'A')) return 'always';
  if (canTell && (key === 't' || key === 'T')) return 'tell';
  if (key === 'n' || key === 'N' || key === '\r' || key === '\n') return 'deny';
  return 'ignore';
}

/** The approval's header. An agent often titles the call with the very
 * command shown under it (`make clean` over `$ make clean`): the header then
 * just says what kind of thing is asked, and the command is shown once. */
export function approvalHeading(title: string, detail?: string): string {
  const named = title.replace(/\s+/g, ' ').trim();
  const repeated = detail?.split('\n').find((line) => line.replace(/^\$\s+/, '').trim() === named);
  return repeated === undefined ? named : repeated.startsWith('$') ? 'Approve command' : 'Approve';
}
