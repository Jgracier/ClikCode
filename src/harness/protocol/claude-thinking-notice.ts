/** Claude's account-bound preserved-thinking warning. The native thread stays
 * intact; only this informational notice is hidden from ClikCode's answer. */
export const OTHER_ORG_THINKING_TITLE = "Claude can't use thinking from another organization";

const OTHER_ORG_THINKING_BODY = `${OTHER_ORG_THINKING_TITLE}\nClaude's earlier thinking was written while you were signed in to another organization, so Claude can't use it now. It isn't deleted: resume this session signed in to that organization to use it again. Claude's next responses may be slower and use more tokens because it has to reread this session and generate new thinking. See docs for more: https://platform.claude.com/docs/en/build-with-claude/preserved-thinking`;

/** Older claude-agent-acp builds inserted the complete notice in answer text.
 * Remove only that exact notice, including when prose follows its final URL. */
export function withoutOtherOrgThinkingNotice(text: string): string {
  const notice = `**Warning:** ${OTHER_ORG_THINKING_BODY}`;
  let at = text.indexOf(notice);
  while (at >= 0) {
    const before = text.slice(0, at).replace(/\n{2}$/, '');
    const after = text.slice(at + notice.length).replace(/^\n{2}/, '');
    text = before && after ? `${before}\n\n${after}` : before + after;
    at = text.indexOf(notice);
  }
  return text;
}
