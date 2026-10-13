import { describe, expect, it } from 'vitest';
import { renderFinished } from '../../src/webview/messages';

describe('saved Claude thinking notice in VS Code', () => {
  it('hides the old adapter banner while showing the continued answer', () => {
    const warning = "**Warning:** Claude can't use thinking from another organization\nClaude's earlier thinking was written while you were signed in to another organization, so Claude can't use it now. It isn't deleted: resume this session signed in to that organization to use it again. Claude's next responses may be slower and use more tokens because it has to reread this session and generate new thinking. See docs for more: https://platform.claude.com/docs/en/build-with-claude/preserved-thinking";
    const html = renderFinished('saved-warning', `Earlier answer.\n\n${warning}Picking up the work.`);
    expect(html).toContain('Earlier answer.');
    expect(html).toContain('Picking up the work.');
    expect(html).not.toContain('thinking from another organization');
  });
});
