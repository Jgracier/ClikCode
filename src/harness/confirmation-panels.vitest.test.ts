/** In the TUI, "that worked" is not a panel. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emitHarnessOutput } from './output.js';
import { TERMINAL } from '../tui/active-terminal.js';

const opened: string[] = [];
const fakeTerminal = { panel: (title: string) => { opened.push(title); }, render: () => undefined } as unknown as NonNullable<typeof TERMINAL.active>;

// Human output, as in a real terminal. Without this stdout is not a TTY under
// the test runner, output falls back to JSON, and nothing below is exercised.
beforeEach(() => { process.env.CLIKCODE_OUTPUT_MODE = 'human'; });
afterEach(() => { TERMINAL.active = undefined; opened.length = 0; delete process.env.CLIKCODE_OUTPUT_MODE; });

describe('a panel in the TUI', () => {
  it('is not opened to confirm something just done', () => {
    TERMINAL.active = fakeTerminal;
    emitHarnessOutput({ panel: 'session-renamed', text: 'Conversation renamed to "Prod Disk Cleanup".' });
    emitHarnessOutput({ panel: 'session-archived', text: 'Conversation archived.' });
    emitHarnessOutput({ panel: 'settings-updated', text: 'Global default updated: effort = high' });
    emitHarnessOutput({ panel: 'copied', text: 'Last response copied to the clipboard.' });
    emitHarnessOutput({ panel: 'cwd', text: 'Working directory is now ~/work', changed: true });
    emitHarnessOutput({ panel: 'attachments', attachments: ['/tmp/a.png'], changed: true });
    expect(opened).toEqual([]);
  });

  it('is still opened to answer a question', () => {
    TERMINAL.active = fakeTerminal;
    emitHarnessOutput({ panel: 'help', helpText: '/model  choose a model' });
    emitHarnessOutput({ panel: 'cwd', text: '~/work', workspace: '/home/me/work' });
    expect(opened.length).toBe(2);
  });
});
