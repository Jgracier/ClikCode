import { describe, expect, it } from 'vitest';
import { splitIntoBlocks } from '../../tui/render/markdown.js';
import { withoutOtherOrgThinkingNotice } from './claude-thinking-notice.js';

describe('Claude preserved-thinking notice display', () => {
  it('removes the saved notice between a quota line and the continued answer', () => {
    const warning = "**Warning:** Claude can't use thinking from another organization\nClaude's earlier thinking was written while you were signed in to another organization, so Claude can't use it now. It isn't deleted: resume this session signed in to that organization to use it again. Claude's next responses may be slower and use more tokens because it has to reread this session and generate new thinking. See docs for more: https://platform.claude.com/docs/en/build-with-claude/preserved-thinking";
    const content = `You've hit your session limit · resets 8:50pm (America/Denver)\n\n${warning}Picking up the work.`;
    expect(withoutOtherOrgThinkingNotice(content)).toBe("You've hit your session limit · resets 8:50pm (America/Denver)\n\nPicking up the work.");
    const blocks = splitIntoBlocks(content);
    expect(blocks.filter((block) => block.kind === 'paragraph').map((block) => withoutOtherOrgThinkingNotice(block.text)).join(' ')).not.toContain('thinking from another organization');
    expect(withoutOtherOrgThinkingNotice('A model discussing this warning in its own words')).toBe('A model discussing this warning in its own words');
  });
});
