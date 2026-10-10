"""End-to-end display checks for the ClikCode TUI, against a fake vendor CLI.

Each scenario runs the real TUI in a pty with isolated state -- its own HOME,
CLIKCODE_HOME, and a PATH holding only the fake harness, node and system
tools, so no real vendor CLI can be selected and no account is touched --
drives it with keystrokes, and snapshots the emulated screen after every
chunk of output. Then it checks what matters for display fragility:

  * once a watched piece of text is on screen it never disappears;
  * at the end every watched piece is on screen exactly once;
  * consecutive blocks never run together without a paragraph break.

    uv run --with pyte scripts/tui-e2e/run.py [--repeat N] [--only NAME] [dist/index.js]

Exit status 0 when every scenario passes every repeat. Captures of failures
are kept (the path is printed) so they can be replayed frame by frame.
"""
import argparse, fcntl, json, os, pty, select, shutil, signal, struct, sys, tempfile, termios, time

import pyte

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
COLS, ROWS = 100, 50


class Screen(pyte.Screen):
    """pyte without the two sequences it lacks: SU and SD (`CSI n S`, `CSI n
    T`), which scroll the region the margins set. A transcript scroll hands
    its shift to the terminal with them; without them the emulator left every
    row but the exposed ones where they were, which looks exactly like a
    screen that does not scroll."""
    def scroll_up(self, count=None, *_args, **_kwargs):
        top, bottom = self.margins or pyte.screens.Margins(0, self.lines - 1)
        saved = (self.cursor.x, self.cursor.y)
        for _ in range(max(1, count or 1)):
            self.cursor.y = bottom
            self.index()
        self.cursor.x, self.cursor.y = saved

    def scroll_down(self, count=None, *_args, **_kwargs):
        top, bottom = self.margins or pyte.screens.Margins(0, self.lines - 1)
        saved = (self.cursor.x, self.cursor.y)
        for _ in range(max(1, count or 1)):
            self.cursor.y = top
            self.reverse_index()
        self.cursor.x, self.cursor.y = saved


class ByteStream(pyte.ByteStream):
    csi = {**pyte.ByteStream.csi, 'S': 'scroll_up', 'T': 'scroll_down'}

TWO_BLOCKS = {'blocks': ['Checking the workspace first.', 'The final commit is live.']}

# Each step: ('type', text) types and presses Enter; ('wait_for', text, secs)
# waits until text is on screen; ('settle', secs) lets the screen quiet down.
# A second window on the same state: ('open2', secs, [args]) opens it, and 'type2',
# 'keys2', 'wait_for2', 'snap2', 'mark2' act on it as their plain forms do
# on the first; ('kill_workers', 'KILL') signals every conversation worker,
# ('expect_workers', n) waits for exactly n to be running. Checks on it:
# 'final2_contains', 'final2_once', 'never2' (from 'mark2' on); on any snap:
# 'snap_lacks', 'snap_once'.
SCENARIOS = {
    'two-blocks-with-tool': {
        'turns': [TWO_BLOCKS],
        'steps': [('type', 'please check the commit'), ('wait_for', 'The final commit is live.', 30), ('settle', 4)],
        'watch': ['please check the commit', 'Checking the workspace first.', 'The final commit is live.'],
        # A turn that ran a tool ends on one line saying so, written once.
        'final_once': ['Worked for'],
        # Never looked away from: no notification.
        'raw_never': ['the turn has finished'],
        'no_clear_after_type': True,
    },
    'rebuild-after-turn-keeps-answer': {
        'rebuild_entry': True,
        'turns': [{'blocks': ['Answer stays visible after the tool.', 'The final answer is ready.']}],
        'steps': [
            ('type', 'check'), ('wait_for', 'Answer stays visible after the tool.', 30),
            ('touch_entry',), ('wait_for', 'The final answer is ready.', 30), ('settle', 20),
        ],
        'watch': ['The final answer is ready.'],
        'no_clear_after_type': True,
    },
    'rebuild-while-following-running-turn': {
        # A newer build lands while a turn runs; the window leaves for the
        # board and comes back. The quiet moment it re-execs at is while the
        # worker still runs that turn, and the new process must follow it to
        # its end and take the next message.
        'rebuild_entry': True,
        'turns': [{'intro': 'Starting the long build.', 'hold_ms': 12000, 'blocks': ['The build passed.']},
                  {'blocks': ['Second answer arrives here.']}],
        'steps': [
            ('type', 'start the build'), ('wait_for', 'sleep 30', 30),
            ('touch_entry',), ('keys', '\x1b[D'), ('settle', 2), ('keys', '\r'), ('settle', 4),
            ('wait_for', 'The build passed.', 40), ('settle', 3),
            ('type', 'and the second question'), ('wait_for', 'Second answer arrives here.', 30), ('settle', 2),
        ],
        'watch': ['The build passed.', 'Second answer arrives here.'],
        'no_clear_after_type': True,
    },
    'board-back-into-running-turn': {
        # Chat B runs a long turn; the window steps out to chat A through the
        # board and comes back to B while that turn still runs. It must follow
        # the turn to its end and take the next message -- it used to stop
        # showing the turn a moment after joining and never ask again.
        'turns': [{'blocks': ['First chat answered.']},
                  {'intro': 'Starting the long build.', 'subagents': {'count': 2, 'calls': 40, 'hold_ms': 15000}, 'blocks': ['The build passed.']},
                  {'blocks': ['Second answer arrives here.']}],
        'steps': [
            ('type', 'hello'), ('wait_for', 'First chat answered.', 30), ('settle', 2),
            # A second chat, started from the board, runs the long turn.
            ('keys', '\x1b[D'), ('settle', 2), ('type', 'start the build'), ('wait_for', 'Starting the long build.', 30), ('settle', 6),
            # Out to the first chat, then back into the running one.
            ('keys', '\x1b[D'), ('settle', 2), ('snap', 'board1'), ('keys', '\x1b[B'), ('keys', '\x1b[C'), ('settle', 3),
            # Back up to the running chat, and into it.
            ('keys', '\x1b[D'), ('settle', 2), ('snap', 'board2'), ('keys', '\x1b[A'), ('keys', '\r'), ('settle', 3),
            ('wait_for', 'The build passed.', 40), ('settle', 3),
            ('type', 'and the second question'), ('wait_for', 'Second answer arrives here.', 30), ('settle', 2),
        ],
        'watch': ['The build passed.', 'Second answer arrives here.'],
        # The board, on the running chat: its one state, and the footer's keys for it.
        'snap_contains': {'board1': ['Working', 'working', '2 agents', 'Recent', 'enter open · tab options · del delete · ← close']},
        # A running sub-agent's title already says it is one.
        'ever': ['Agent worker 0'], 'never': ['agent Agent'],
        'no_clear_after_type': True,
    },
    # Deleting the chat that is open, on the board, then closing the board:
    # the window carries on in the fresh chat that took its place. It used to
    # exit ClikCode, leaving the deleted chat's text on the shell's screen.
    'delete-open-chat-then-esc': {
        'turns': [{'blocks': ['DOOMED answer lives here.']}, {'blocks': ['Fresh chat answered.']}],
        'steps': [
            ('type', 'doomed question'), ('wait_for', 'DOOMED answer lives here.', 30), ('settle', 2),
            ('keys', '\x1b[D'), ('settle', 2), ('keys', '\x1b[3~'), ('wait_for', 'Cancel', 10),
            ('keys', '\x1b[B'), ('keys', '\r'), ('settle', 3), ('keys', '\x1b'), ('settle', 2), ('mark',),
            ('type', 'still here'), ('wait_for', 'Fresh chat answered.', 30), ('settle', 2),
        ],
        'watch': [], 'final_contains': ['still here', 'Fresh chat answered.'],
        'never_after_mark': ['DOOMED answer lives here.'],
    },
    # Another window deletes the chat this one has open. The next message
    # here is not lost and does not end ClikCode ("AI session ... was not
    # found"): a fresh chat opens, says why, and the message waits in its
    # composer.
    'chat-deleted-in-other-window': {
        'turns': [{'blocks': ['DOOMED answer lives here.']}, {'blocks': ['Fresh chat answered.']}],
        'steps': [
            ('type', 'doomed question'), ('wait_for', 'DOOMED answer lives here.', 30), ('settle', 2),
            ('open2', 6, ['--continue']), ('wait_for2', 'DOOMED answer lives here.', 10),
            ('keys2', '\x1b[D'), ('settle', 2), ('keys2', '\x1b[3~'), ('wait_for2', 'Cancel', 10),
            ('keys2', '\x1b[B'), ('keys2', '\r'), ('settle', 3),
            ('mark',), ('type', 'are you there'), ('wait_for', 'was deleted', 15), ('settle', 2), ('snap', 'kept'),
            ('keys', '\r'), ('wait_for', 'Fresh chat answered.', 30), ('settle', 2),
        ],
        'watch': [], 'final_contains': ['are you there', 'Fresh chat answered.'],
        'snap_contains': {'kept': ['› are you there']},
        'never_after_mark': ['not found'],
    },
    # A window with no worker attached -- its worker stopped (a rebuild
    # retires them), or none ever ran -- sees the turn another window starts.
    # It used to sit at its prompt showing none of it.
    'unattached-window-sees-other-turn': {
        'turns': [{'blocks': ['First chat answered.']}, {'blocks': ['Second answer arrives here.']}],
        'steps': [
            ('type', 'hello'), ('wait_for', 'First chat answered.', 30), ('settle', 2),
            ('kill_workers', 'TERM'), ('expect_workers', 0), ('settle', 2),
            ('open2', 6, ['--continue']), ('wait_for2', 'First chat answered.', 10),
            ('type2', 'from the other window'), ('wait_for2', 'Second answer arrives here.', 30),
            ('wait_for', 'Second answer arrives here.', 15), ('settle', 2),
        ],
        'watch': [], 'final_contains': ['from the other window'],
        'final_once': ['Second answer arrives here.'], 'final2_once': ['Second answer arrives here.'],
    },
    # The worker running a turn is killed mid-call. The turn ends there as a
    # stopped one, under its own prompt -- its answer used to be drawn above
    # it, the call left running (▸), and "session worker connection closed
    # unexpectedly" shown -- and the next message starts a worker again.
    'worker-killed-mid-turn': {
        'turns': [{'intro': 'Starting the long build.', 'hold_ms': 20000, 'blocks': ['The build passed.']},
                  {'blocks': ['Second answer arrives here.']}],
        'steps': [
            ('type', 'start the build'), ('wait_for', 'sleep 30', 30), ('settle', 2),
            ('kill_workers', 'KILL'), ('wait_for', 'send again to continue', 10), ('settle', 2), ('snap', 'stopped'),
            ('type', 'carry on'), ('wait_for', 'Second answer arrives here.', 30), ('settle', 2),
        ],
        'watch': [],
        # Its call settled as stopped. No closing line: the worker that would
        # have saved the turn's end is gone, and that line is the saved one.
        'snap_contains': {'stopped': ["The conversation's worker stopped; send again to continue.", 'sleep 30 stopped']},
        'snap_once': {'stopped': ['start the build', 'Starting the long build.']},
        'snap_lacks': {'stopped': ['▸', 'Worked for']},
        'final_once': ['Second answer arrives here.'], 'never': ['closed unexpectedly'],
    },
    # Esc on a turn that has not answered yet takes the message back -- into
    # the composer of the window that pressed it, and no other. A second
    # window on the chat used to get the same draft put into its composer.
    'esc-take-back-only-in-its-window': {
        'turns': [{'blocks': ['First chat answered.']},
                  {'thought': {'text': 'Pondering the request slowly.', 'ms': 20000}, 'blocks': ['Never gets here.']}],
        'steps': [
            ('type', 'hello'), ('wait_for', 'First chat answered.', 30), ('settle', 2),
            ('open2', 6, ['--continue']), ('wait_for2', 'First chat answered.', 10), ('settle', 1),
            ('type', 'take this back'), ('wait_for', 'Pondering', 20), ('wait_for2', 'Pondering', 20), ('settle', 1),
            ('keys', '\x1b'), ('settle', 4), ('snap', 'one'), ('snap2', 'two'),
        ],
        'watch': [], 'snap_contains': {'one': ['› take this back', 'draft restored'], 'two': ['Stopped']},
        'snap_lacks': {'two': ['› take this back', 'draft restored']},
    },
    # A turn one window started is stopped from another (Esc there stops the
    # shared turn). Both end it as stopped -- the window that started it used
    # to say "Worked for", as if it had finished.
    'stopped-from-other-window': {
        'env': {'FAKE_DELAY_MS': '400'},
        'turns': [{'blocks': ['First chat answered.']},
                  {'blocks': ['Checking the workspace first.', 'The final commit is live and many more words follow here slowly until the end.']}],
        'steps': [
            ('type', 'hello'), ('wait_for', 'First chat answered.', 30), ('settle', 2),
            ('open2', 6, ['--continue']), ('wait_for2', 'First chat answered.', 10), ('settle', 1),
            ('type', 'check the commit'), ('wait_for', 'The final', 30), ('wait_for2', 'The final', 20), ('settle', 1),
            ('keys2', '\x1b'), ('wait_for2', 'Stopped after', 10), ('settle', 3),
        ],
        'watch': [], 'final_once': ['Stopped after'], 'final2_once': ['Stopped after'],
        'never': ['Worked for'], 'never2': ['Worked for'],
    },
    # "Worked for" is the saved turn's, not only the window's that watched it
    # end: it is there after going to another chat and back, and after the
    # window is closed and opened again. It used to be drawn live only.
    'worked-for-survives-board-and-restart': {
        'turns': [TWO_BLOCKS, {'blocks': ['Other chat answered.']}],
        'steps': [
            ('type', 'please check the commit'), ('wait_for', 'Worked for', 30), ('settle', 2),
            ('keys', '\x1b[D'), ('settle', 2), ('type', 'another chat'), ('wait_for', 'Other chat answered.', 30), ('settle', 2),
            ('keys', '\x1b[D'), ('settle', 2), ('keys', '\x1b[B'), ('settle', 0.5), ('keys', '\r'),
            ('wait_for', 'The final commit is live.', 10), ('settle', 2), ('snap', 'back'),
            ('restart',), ('keys', '\x1b[D'), ('settle', 2), ('keys', '\x1b[B'), ('settle', 0.5), ('keys', '\r'),
            ('wait_for', 'The final commit is live.', 10), ('settle', 2),
        ],
        'watch': [], 'snap_once': {'back': ['Worked for']}, 'final_once': ['Worked for'],
        'final_contains': ['please check the commit'],
    },
    # The board's small print. Empty, it says so. Deleting asks about the
    # chat by its preview (every new one is "Untitled chat"), offers no
    # filter on a two-row list, and says Esc closes -- not "exit", which it
    # does not. A draft typed before choosing a row goes with that row.
    'board-small-print': {
        'turns': [{'blocks': ['First chat answered.']}],
        'steps': [
            ('keys', '\x1b[D'), ('settle', 2), ('snap', 'empty'), ('keys', '\x1b'), ('settle', 1),
            ('type', 'hello there'), ('wait_for', 'First chat answered.', 30), ('settle', 2),
            ('keys', '\x1b[D'), ('settle', 2), ('keys', '\x1b[3~'), ('wait_for', 'Cancel', 10), ('settle', 0.5), ('snap', 'confirm'),
            ('keys', '\x1b'), ('settle', 1), ('keys', 'keep me'), ('settle', 0.5), ('keys', '\x1b[B'), ('settle', 0.5),
            ('keys', '\r'), ('wait_for', 'First chat answered.', 10), ('settle', 1), ('snap', 'kept'),
        ],
        'watch': [],
        'snap_contains': {'empty': ['No conversations yet'], 'confirm': ['· hello there?', 'esc close'], 'kept': ['› keep me']},
        'snap_lacks': {'confirm': ['type to filter', 'esc exit']},
    },
    'single-block': {
        'turns': [{'blocks': ['Hello there, all good.']}],
        'steps': [('type', 'hi'), ('wait_for', 'Hello there, all good.', 30), ('settle', 4)],
        'watch': ['Hello there, all good.'],
    },
    'two-turns': {
        'turns': [TWO_BLOCKS, {'blocks': ['Second answer arrives here.']}],
        'steps': [
            ('type', 'please check the commit'), ('wait_for', 'The final commit is live.', 30), ('settle', 4),
            ('type', 'and the second question'), ('wait_for', 'Second answer arrives here.', 30), ('settle', 4),
        ],
        'watch': ['please check the commit', 'Checking the workspace first.', 'The final commit is live.',
                  'and the second question', 'Second answer arrives here.'],
        # Only the first turn ran a tool; the second, short and tool-free, ends bare.
        'final_once': ['Worked for'],
    },
    # A notice ClikCode sends the model in the user's place is drawn as a
    # muted ClikCode notice, under its own label, never as the user's `›`.
    'clikcode-notice-row': {
        'turns': [{'blocks': ['Nothing needs restarting.']}],
        # Typed here to stand in for the worker's queued notice; once sent
        # (the composer is empty again) it is never drawn as the user's.
        'steps': [('type', '[ClikCode] Background work was stopped: a test.'), ('mark',),
                  ('wait_for', 'Nothing needs restarting.', 30), ('settle', 3)],
        'watch': ['Nothing needs restarting.'],
        'final_contains': ['ClikCode notice', 'Background work was stopped: a test.'],
        'never_after_mark': ['› [ClikCode]', '[ClikCode] Background'],
    },
    'message-typed-mid-answer': {
        'turns': [TWO_BLOCKS, {'blocks': ['Queued one answered now.']}],
        'steps': [
            ('type', 'please check the commit'), ('wait_for', 'Checking the workspace first.', 30),
            ('type', 'also look at the tests'), ('wait_for', 'Queued one answered now.', 40), ('settle', 4),
        ],
        'watch': ['please check the commit', 'Checking the workspace first.', 'The final commit is live.',
                  'also look at the tests', 'Queued one answered now.'],
    },
    'generic-json-two-blocks': {
        'harness': 'cmdc', 'family': 'generic',
        'turns': [TWO_BLOCKS],
        'steps': [('type', 'please check the commit'), ('wait_for', 'The final commit is live.', 30), ('settle', 4)],
        'watch': ['please check the commit', 'Checking the workspace first.', 'The final commit is live.'],
    },
    # Opening $EDITOR (/memory edit) hands the terminal over and takes it
    # back: swipe scrolling and bracketed paste must come back with it.
    'editor-keeps-modes': {
        'turns': [TWO_BLOCKS],
        'steps': [('type', 'please check the commit'), ('wait_for', 'The final commit is live.', 30), ('settle', 1),
                  ('type', '/memory edit'), ('settle', 3)],
        'env': {'EDITOR': '/bin/true'},
        'watch': [], 'final_contains': ['The final commit is live.'],
    },
    # /select gives the mouse back to the terminal and /select again takes
    # it: each goes out with the next frame, in that order.
    'select-mode-toggles-mouse': {
        'turns': [TWO_BLOCKS],
        'steps': [('type', '/select'), ('wait_for', 'Selection mode on', 10), ('settle', 1),
                  ('type', '/select'), ('wait_for', 'Selection mode off', 10), ('settle', 1)],
        'watch': [],
        'raw_in_order': ['\x1b[?1000h', '\x1b[?1006l\x1b[?1016l\x1b[?1003l\x1b[?1002l\x1b[?1000l', '\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h'],
    },
    'select-and-copy': {
        'turns': [TWO_BLOCKS],
        'steps': [
            ('type', 'please check the commit'), ('wait_for', 'The final commit is live.', 30), ('settle', 3),
            ('select', 'final commit is live'), ('settle', 1),
        ],
        'watch': ['please check the commit', 'Checking the workspace first.', 'The final commit is live.'],
        'clipboard': 'final commit is live',
    },
    'model-changed-mid-answer': {
        'turns': [TWO_BLOCKS],
        'steps': [
            ('type', 'please check the commit'), ('wait_for', 'Checking the workspace first.', 30),
            ('type', '/model grok-4-fast'), ('wait_for', 'The final commit is live.', 30), ('settle', 4),
        ],
        'watch': ['please check the commit', 'Checking the workspace first.', 'The final commit is live.'],
        'final_contains': ['grok-4-fast'],
    },
    'redraw-idle': {
        'turns': [{'blocks': ['The final commit is live.']}],
        'steps': [
            ('type', 'please check the commit'), ('wait_for', 'The final commit is live.', 30),
            ('settle', 2), ('quiet', 2), ('damage_and_redraw', 'The final commit is live.'),
        ],
        'watch': [], 'final_contains': ['The final commit is live.'],
    },
    'redraw-command-list': {
        'turns': [TWO_BLOCKS],
        'steps': [('keys', '/'), ('wait_for', '/settings', 5), ('damage_and_redraw', '/settings')],
        'watch': [], 'final_contains': ['/settings'],
    },
    # Ctrl+L on the conversation board and in a picker draws the whole
    # screen again, as it does at the composer. Both ignored it.
    'redraw-board': {
        'turns': [{'blocks': ['First chat answered.']}],
        'steps': [('type', 'hello'), ('wait_for', 'First chat answered.', 30), ('settle', 2),
                  ('keys', '\x1b[D'), ('wait_for', 'Recent', 10), ('settle', 1), ('damage_and_redraw', 'Recent')],
        'watch': [], 'final_contains': ['Recent'],
    },
    'redraw-picker': {
        'turns': [TWO_BLOCKS],
        'steps': [('keys', '/effort'), ('settle', 1), ('keys', '\r'), ('wait_for', 'Reasoning effort', 10), ('settle', 1),
                  ('damage_and_redraw', 'Reasoning effort')],
        'watch': [], 'final_contains': ['Reasoning effort'],
    },
    # The board on a phone whose keyboard comes up: 63 rows to 32. It is
    # repainted as the board -- its headings as the board draws them, its
    # list fitted to the new height -- not in the slash palette's style
    # ("── Recent", indented rows) the repaint used to fall back to.
    'board-resize-keeps-board': {
        'cols': 70, 'rows': 63,
        'turns': [{'blocks': ['First chat answered.']}],
        'steps': [('type', 'hello'), ('wait_for', 'First chat answered.', 30), ('settle', 2),
                  ('keys', '\x1b[D'), ('wait_for', 'Recent', 10), ('settle', 1),
                  ('resize', 32, 70), ('settle', 2), ('snap', 'short')],
        'watch': [], 'snap_contains': {'short': ['Recent', 'enter open']}, 'snap_lacks': {'short': ['── Recent']},
    },
    'redraw-while-waiting': {
        'turns': [TWO_BLOCKS],
        'steps': [
            ('type', 'please check the commit'), ('wait_for', 'Checking the workspace first.', 30),
            ('damage_and_redraw', 'Checking the workspace first.'),
            ('wait_for', 'The final commit is live.', 30), ('settle', 2),
        ],
        'watch': [], 'final_contains': ['Checking the workspace first.', 'The final commit is live.'],
    },
    'mobile-resize-burst': {
        'turns': [TWO_BLOCKS],
        'steps': [
            ('type', 'please check the commit'), ('wait_for', 'Checking the workspace first.', 30),
            ('resize_burst',), ('wait_for', 'The final commit is live.', 30), ('settle', 2),
        ],
        'watch': [], 'final_contains': ['Checking the workspace first.', 'The final commit is live.'],
    },
    'title-after-mobile-resize': {
        'turns': [{'blocks': ['<clikcode-title>My Mobile Chat</clikcode-title>\nThe final commit is live.']}],
        'steps': [
            ('type', 'please check the commit'), ('resize_burst',),
            ('wait_for', 'The final commit is live.', 30), ('settle', 2),
        ],
        'watch': [], 'final_contains': ['My Mobile Chat', 'The final commit is live.'],
    },
    'narrow-mid-transcript': {
        # A row written at 100 columns is wider than the screen at 60. It
        # must be wrapped again, not clipped (its tail lost) and not left to
        # the terminal's autowrap (every row below it one out).
        'turns': [{'blocks': ['Checking the workspace first, reading each file that the commit touched NARROWTAIL.',
                              'The final commit is live.']}],
        'steps': [
            ('type', 'please check the commit'), ('wait_for', 'The final commit is live.', 30), ('settle', 3),
            ('resize', 50, 60), ('settle', 2),
        ],
        'watch': [], 'final_contains': ['please check the commit', 'NARROWTAIL.', 'The final commit is live.'],
        'final_once': ['NARROWTAIL.', 'The final commit is live.'],
    },
    # A long turn on a phone-width terminal, left for the board and joined
    # again several times while it keeps streaming. The running turn is
    # drawn once, live -- never folded in as an ended turn above a second,
    # live copy of itself, and never with its answer written twice.
    'board-and-back-mid-turn': {
        'cols': 70, 'env': {'FAKE_DELAY_MS': '350'},
        'turns': [{'blocks': ['Step one of the long job.', 'Step two of the long job.', 'Step three of the long job.',
                              'Step four of the long job.', 'The long job is finished.']}],
        'steps': [
            ('type', 'run the long job'), ('wait_for', 'Step one of the long job.', 30),
            ('keys', '\x1b[D'), ('settle', 1.5), ('keys', '\r'), ('settle', 2),
            ('keys', '\x1b[D'), ('settle', 1.5), ('keys', '\r'), ('settle', 2),
            ('keys', '\x1b[D'), ('settle', 1.5), ('keys', '\r'),
            ('wait_for', 'The long job is finished.', 60), ('settle', 3),
        ],
        'watch': [], 'final_once': ['run the long job', 'Step one of the long job.', 'The long job is finished.'],
        'never': ['Interrupted turn activity'],
    },
    # The phone's case: nothing but tool calls for a long while, then out to
    # the board and back, again and again, while more calls arrive.
    'board-and-back-tools-only': {
        # Tall enough for the prompt, ten calls, the answer and the turn's
        # closing line all at once: the prompt is one of the rows counted.
        'cols': 70, 'rows': 56, 'env': {'FAKE_TOOL_MS': '1500'},
        'turns': [{'tools_first': 10, 'blocks': ['All ten parts pass.']}],
        'steps': [
            ('type', 'run every part'), ('wait_for', 'vitest run part0', 30), ('settle', 4),
            ('keys', '\x1b[D'), ('settle', 1.5), ('keys', '\r'), ('settle', 1.5),
            ('keys', '\x1b[D'), ('settle', 1.5), ('keys', '\r'), ('settle', 1.5),
            ('keys', '\x1b[D'), ('settle', 1.5), ('keys', '\r'),
            ('wait_for', 'All ten parts pass.', 60), ('settle', 3),
        ],
        'watch': [], 'final_once': ['run every part', 'All ten parts pass.'],
        'never': ['Interrupted turn activity'],
    },
    # Out to the board, into ANOTHER conversation, and back into this one,
    # twice, while the long turn keeps running in its worker.
    'other-conversation-and-back-mid-turn': {
        'cols': 70, 'env': {'FAKE_TOOL_MS': '2000'},
        'turns': [{'blocks': ['A short first answer.']}, {'tools_first': 12, 'blocks': ['All twelve parts pass.']}],
        'steps': [
            ('type', 'say something short'), ('wait_for', 'A short first answer.', 30), ('settle', 2),
            # A new conversation, started from the board by typing.
            ('keys', '\x1b[D'), ('settle', 2),
            ('type', 'run every part'), ('wait_for', 'vitest run part0', 30), ('settle', 4),
            ('keys', '\x1b[D'), ('settle', 1.5), ('keys', '\x1b[B'), ('settle', 0.5), ('keys', '\r'), ('settle', 2),
            ('keys', '\x1b[D'), ('settle', 1.5), ('keys', '\x1b[A'), ('settle', 0.5), ('keys', '\r'), ('settle', 2.5),
            ('keys', '\x1b[D'), ('settle', 1.5), ('keys', '\x1b[B'), ('settle', 0.5), ('keys', '\r'), ('settle', 2),
            ('keys', '\x1b[D'), ('settle', 1.5), ('keys', '\x1b[A'), ('settle', 0.5), ('keys', '\r'),
            ('wait_for', 'All twelve parts pass.', 60), ('settle', 3),
        ],
        # Rejoined, the turn is drawn with every call it made, which pushes
        # its prompt above a 50-row screen: its rows are what is counted.
        'watch': [], 'final_once': ['part2 ok', 'part11 ok', 'All twelve parts pass.'],
        'never': ['Interrupted turn activity'],
    },
    # Into another conversation and back. The conversation joined is the only
    # one on screen, even scrolled all the way up: the one left is not kept
    # above it, and no screenful of blank rows separates them.
    'switch-shows-only-that-conversation': {
        'cols': 70,
        'turns': [{'blocks': ['ALPHA answer lives here.']}, {'blocks': ['BETA answer lives here.']}],
        'steps': [
            ('type', 'first conversation question'), ('wait_for', 'ALPHA answer lives here.', 30), ('settle', 2),
            ('keys', '\x1b[D'), ('settle', 2),
            ('type', 'second conversation question'), ('wait_for', 'BETA answer lives here.', 30), ('settle', 2),
            ('keys', '\x1b[D'), ('settle', 1.5), ('keys', '\x1b[B'), ('settle', 0.5), ('keys', '\r'),
            ('wait_for', 'ALPHA answer lives here.', 10), ('mark',), ('settle', 2),
            ('keys', '\x1b[<64;10;10M' * 40), ('settle', 1),
        ],
        'watch': [], 'final_contains': ['first conversation question', 'ALPHA answer lives here.'],
        'never_after_mark': ['BETA answer lives here.', 'second conversation question'],
    },
    # The phone report: back into a conversation while its turn is running.
    # Its earlier history is there above the live turn -- not cut off at the
    # live answer -- and the conversation left is nowhere, scrolled up or not.
    'switch-into-running-turn-keeps-history': {
        'cols': 70, 'env': {'FAKE_TOOL_MS': '1500'},
        'turns': [{'blocks': ['ALPHA answer lives here.']}, {'blocks': ['BETA answer lives here.']},
                  {'tools_first': 8, 'blocks': ['All eight parts pass.']}],
        'steps': [
            ('type', 'first conversation question'), ('wait_for', 'ALPHA answer lives here.', 30), ('settle', 2),
            ('keys', '\x1b[D'), ('settle', 2),
            ('type', 'second conversation question'), ('wait_for', 'BETA answer lives here.', 30), ('settle', 2),
            ('keys', '\x1b[D'), ('settle', 1.5), ('keys', '\x1b[B'), ('settle', 0.5), ('keys', '\r'),
            ('wait_for', 'ALPHA answer lives here.', 10), ('settle', 1),
            ('type', 'run every part'), ('wait_for', 'vitest run part0', 30), ('settle', 3),
            ('keys', '\x1b[D'), ('settle', 1.5), ('keys', '\x1b[B'), ('settle', 0.5), ('keys', '\r'),
            ('wait_for', 'BETA answer lives here.', 10), ('settle', 1.5),
            ('keys', '\x1b[D'), ('settle', 1.5), ('keys', '\x1b[A'), ('settle', 0.5), ('keys', '\r'),
            ('wait_for', 'run every part', 10), ('mark',), ('settle', 1),
            ('keys', '\x1b[<64;10;10M' * 40), ('settle', 1),
        ],
        'watch': [],
        'ever_after_mark': ['first conversation question', 'ALPHA answer lives here.'],
        'never_after_mark': ['BETA answer lives here.', 'second conversation question'],
    },
    # The slash menu, a step at a time. Choosing a command that takes a value
    # opens its own titled picker -- the typed command gone, never left under
    # it -- starting on the current value, and the change is confirmed.
    'slash-command-opens-picker': {
        'turns': [TWO_BLOCKS],
        'steps': [('keys', '/effort'), ('settle', 1), ('keys', '\r'), ('wait_for', 'Reasoning effort', 10), ('settle', 0.5),
                  ('keys', '\x1b[B'), ('settle', 0.5), ('keys', '\r'), ('wait_for', 'Effort set to High', 10)],
        'watch': [], 'ever': ['❯ Medium  · current', 'Effort set to High'],
        'never_together': [('› /effort', 'Reasoning effort'), ('tab complete · enter run', 'Reasoning effort')],
    },
    # What runs is what is highlighted: a typed command starts highlighted,
    # and its picker replaces it.
    # /resume is a command like any other: `/res` highlights it (not
    # /compact, whose description says "f-res-h") and Enter opens the board.
    # It used to print "Press ← on an empty prompt…" instead.
    'slash-resume-opens-board': {
        'turns': [{'blocks': ['First chat answered.']}],
        'steps': [('type', 'hello'), ('wait_for', 'First chat answered.', 30), ('settle', 2),
                  ('keys', '/res'), ('settle', 1), ('snap', 'palette'), ('keys', '\r'), ('wait_for', 'Recent', 10),
                  ('settle', 1), ('snap', 'board')],
        'watch': [], 'snap_contains': {'palette': ['❯ /resume'], 'board': ['enter open']},
        'never': ['Press ← on an empty prompt'],
    },
    # `/new <text>` starts a new chat with that text as its first message; it
    # used to throw the text away for a notice.
    'slash-new-sends-text': {
        'turns': [{'blocks': ['OLD answer lives here.']}, {'blocks': ['New chat answered.']}],
        'steps': [('type', 'old question'), ('wait_for', 'OLD answer lives here.', 30), ('settle', 2), ('mark',),
                  ('type', '/new carry this over'), ('wait_for', 'New chat answered.', 30), ('settle', 2), ('snap', 'end')],
        'watch': [], 'final_contains': ['carry this over', 'New chat answered.'],
        'never_after_mark': ['Press ← on an empty prompt'], 'snap_lacks': {'end': ['OLD answer']},
    },
    # `/clear` is Claude Code's: a new, empty chat (the old one stays
    # resumable). It is /new's alias, and was swallowed with it.
    'slash-clear-starts-new-chat': {
        'turns': [{'blocks': ['OLD answer lives here.']}, {'blocks': ['New chat answered.']}],
        'steps': [('type', 'old question'), ('wait_for', 'OLD answer lives here.', 30), ('settle', 2),
                  ('type', '/clear'), ('settle', 3), ('snap', 'cleared'),
                  ('type', 'fresh question'), ('wait_for', 'New chat answered.', 30), ('settle', 2)],
        'watch': [], 'snap_lacks': {'cleared': ['OLD answer lives here.', 'Press ← on an empty prompt']},
        'final_contains': ['fresh question', 'New chat answered.'],
    },
    'typed-command-highlighted': {
        'turns': [TWO_BLOCKS],
        'steps': [('keys', '/account'), ('settle', 1), ('keys', '\r'), ('wait_for', 'Grok Build accounts', 10), ('settle', 1)],
        'watch': [], 'ever': ['❯ /account'],
        'never_together': [('› /account', 'Grok Build accounts'), ('tab complete · enter run', 'Grok Build accounts')],
    },
    # Del on a signed-in account asks first, then signs it out: the row
    # turns to reauth and the vendor's own logout ran.
    'account-del-disconnects': {
        'turns': [TWO_BLOCKS],
        # Signed in by the first message: nothing signs in at launch.
        'steps': [('type', 'please check the commit'), ('wait_for', 'The final commit is live.', 40), ('settle', 1),
                  ('keys', '/account'), ('settle', 1), ('keys', '\r'), ('wait_for', 'Grok Build accounts', 10), ('settle', 2),
                  ('keys', '\x1b[3~'), ('wait_for', 'Cancel', 10), ('settle', 0.5),
                  ('keys', '\x1b[B'), ('settle', 0.3), ('keys', '\r'), ('wait_for', 'reauth', 15), ('settle', 1)],
        'watch': [], 'ever': ['del disconnect', 'Cancel'], 'final_contains': ['reauth'],
    },
    # The same from a Mac or iPhone, whose "delete" key sends Backspace.
    'account-backspace-disconnects': {
        'turns': [TWO_BLOCKS],
        # Signed in by the first message: nothing signs in at launch.
        'steps': [('type', 'please check the commit'), ('wait_for', 'The final commit is live.', 40), ('settle', 1),
                  ('keys', '/account'), ('settle', 1), ('keys', '\r'), ('wait_for', 'Grok Build accounts', 10), ('settle', 2),
                  ('keys', '\x7f'), ('wait_for', 'Cancel', 10), ('settle', 0.5),
                  ('keys', '\x1b[B'), ('settle', 0.3), ('keys', '\r'), ('wait_for', 'reauth', 15), ('settle', 1)],
        'watch': [], 'ever': ['del disconnect', 'Cancel'], 'final_contains': ['reauth'],
    },
    # Adding a Grok account: its sign-in is a link and a code, shown on
    # ClikCode's own screen -- the vendor's own text never takes it over.
    'account-add-link-sign-in': {
        'turns': [TWO_BLOCKS],
        'steps': [('keys', '/account'), ('settle', 1), ('keys', '\r'), ('wait_for', 'Grok Build accounts', 10), ('settle', 2),
                  ('keys', '\x1b[B'), ('settle', 0.5), ('keys', '\r'), ('wait_for', 'the code AB12-CD34', 15),
                  ('wait_for', 'signed in to', 15), ('settle', 1)],
        'watch': [], 'ever': ['Sign in to Grok Build · confirm the code AB12-CD34', 'https://accounts.x.ai/oauth2/device?user_code=AB12-CD34', 'waiting for you to sign in'],
        'final_contains': ['signed in to'], 'never': ['Confirm this code in your browser', 'Waiting for authorization', 'not a tty'],
    },
    # A sign-in that asks for a key: asked under ClikCode's band, typed
    # there as dots, never the vendor's own prompt on screen.
    'account-add-key-sign-in': {
        'turns': [TWO_BLOCKS],
        'env': {'FAKE_LOGIN_KEY': 'sk-test-42'},
        # Signed out: the first message signs in, then is answered.
        'steps': [('type', 'please check the commit'), ('wait_for', 'type it and press Enter', 15), ('settle', 0.5),
                  ('keys', 'sk-test-42'), ('settle', 0.5), ('keys', '\r'), ('wait_for', 'signed in to', 15),
                  ('wait_for', 'The final commit is live.', 40), ('settle', 1)],
        'watch': [], 'ever': ['Paste your API key · type it and press Enter', '••••••••••'],
        'final_contains': ['signed in to', 'The final commit is live.'], 'never': ['sk-test-42', 'Paste your API key: ', 'did not finish'],
    },
    # A question with a shown default after the key (Hermes's `Base URL
    # [...]:`): Enter alone answers it -- a stray Enter on the key does not.
    'key-sign-in-default-answer': {
        'turns': [TWO_BLOCKS],
        'env': {'FAKE_LOGIN_KEY': 'sk-test-42', 'FAKE_LOGIN_DEFAULT': '1'},
        'steps': [('type', 'please check the commit'), ('wait_for', 'type it and press Enter', 15), ('settle', 0.5),
                  ('keys', '\r'), ('settle', 0.5), ('keys', 'sk-test-42'), ('settle', 0.5), ('keys', '\r'),
                  ('wait_for', 'Base URL', 15), ('settle', 0.5), ('keys', '\r'), ('wait_for', 'signed in to', 15),
                  ('wait_for', 'The final commit is live.', 40), ('settle', 1)],
        'watch': [], 'ever': ['Paste your API key · type it and press Enter', 'Base URL [https://api.example.test/v1] · type it and press Enter'],
        'final_contains': ['signed in to', 'The final commit is live.'], 'never': ['sk-test-42', 'did not finish'],
    },
    # A rejected key is never shown back: the failure is one line, and the
    # vendor's last line -- its prompt with the typed key on it -- is not it.
    'key-sign-in-rejected-hides-key': {
        'turns': [TWO_BLOCKS],
        'env': {'FAKE_LOGIN_KEY': 'sk-test-42'},
        'steps': [('type', 'please check the commit'), ('wait_for', 'type it and press Enter', 15), ('settle', 0.5),
                  ('keys', 'sk-wrong-key-99'), ('settle', 0.5), ('keys', '\r'), ('settle', 6)],
        'watch': [], 'never': ['sk-wrong', 'Error:'], 'final_once': ['did not finish'],
    },
    # Esc cancels a sign-in the first message opened, and the band says it
    # does: one plain line says it was cancelled, and the message goes back
    # to the composer to send again.
    'esc-cancels-sign-in': {
        'cols': 70,
        'turns': [TWO_BLOCKS],
        'hold_sign_in': True,
        'steps': [('type', 'start the work'), ('wait_for', 'waiting for you to sign in', 30), ('settle', 0.5), ('snap', 'band'),
                  ('keys', '\x1b'), ('wait_for', 'cancelled', 10), ('settle', 2), ('snap', 'after')],
        'watch': [], 'snap_contains': {'band': ['esc cancel'], 'after': ['› start the work']},
        'final_once': ['Sign-in to Grok Build cancelled'], 'never': ['Error:', 'did not finish', 'Stopped'],
    },
    # Ctrl+C in a sign-in's key field: one press cancels it, said the same way.
    'ctrl-c-cancels-key-sign-in': {
        'cols': 70,
        'turns': [TWO_BLOCKS],
        'env': {'FAKE_LOGIN_KEY': 'sk-test-42'},
        'steps': [('type', 'start the work'), ('wait_for', 'type it and press Enter', 15), ('settle', 0.5),
                  ('keys', '\x03'), ('wait_for', 'cancelled', 10), ('settle', 2), ('snap', 'after')],
        'watch': [], 'snap_contains': {'after': ['› start the work']},
        'final_once': ['Sign-in to Grok Build cancelled'], 'never': ['Error:', 'did not finish'],
    },
    # Adding an account from /account: Esc cancels its sign-in too.
    'esc-cancels-account-sign-in': {
        'turns': [TWO_BLOCKS],
        'hold_sign_in': True,
        'steps': [('keys', '/account'), ('settle', 1), ('keys', '\r'), ('wait_for', 'Grok Build accounts', 10), ('settle', 2),
                  ('keys', '\x1b[B'), ('settle', 0.5), ('keys', '\r'), ('wait_for', 'the code AB12-CD34', 15), ('settle', 0.5),
                  ('keys', '\x1b'), ('wait_for', 'cancelled', 10), ('settle', 2)],
        'watch': [], 'final_once': ['Sign-in to Grok Build cancelled'], 'never': ['Error:', 'did not finish'],
    },
    # Nothing signs in at launch: a signed-out provider waits for its first
    # message.
    'no-sign-in-at-launch': {
        'turns': [TWO_BLOCKS],
        'steps': [('settle', 6)],
        'watch': [], 'never': ['waiting for you to sign in', 'signed in to', 'Sign in to'],
    },
    # A message typed while the first message's sign-in is still finishing:
    # every key of it arrives, once. They used to go nowhere, and the message
    # was sent as "heck the commit".
    'type-during-sign-in': {
        'turns': [TWO_BLOCKS, {'blocks': ['The second one is answered.']}],
        'steps': [('type', 'start the work'), ('wait_for', 'waiting for you to sign in', 30),
                  ('type_slow', 'please check the commit', 0.2),
                  ('wait_for', 'The second one is answered.', 60), ('settle', 2)],
        'watch': ['please check the commit', 'The second one is answered.'],
        'ever': ['signed in to'],
    },
    # The same message sent (Enter) while the sign-in is still waiting on the
    # browser: it is sent once the sign-in has finished, not dropped.
    'send-during-sign-in': {
        'turns': [TWO_BLOCKS, {'blocks': ['The second one is answered.']}],
        'hold_sign_in': True,
        'steps': [('type', 'start the work'), ('wait_for', 'waiting for you to sign in', 30), ('settle', 0.3),
                  ('type', 'please check the commit'), ('settle', 1),
                  ('release_sign_in',),
                  ('wait_for', 'The second one is answered.', 60), ('settle', 2)],
        'watch': ['please check the commit', 'The second one is answered.'],
        'ever': ['signed in to'],
    },
    # Back from a sub-menu lands on the row it was opened from, with no
    # spinner or empty composer flashed on the way into the list.
    'settings-back-lands-on-row': {
        'turns': [TWO_BLOCKS],
        'steps': [('keys', '/settings'), ('settle', 1), ('keys', '\r'), ('wait_for', 'Swarm', 10), ('settle', 0.5),
                  ('keys', '\x1b[B'), ('settle', 0.3), ('keys', '\x1b[B'), ('settle', 0.5), ('keys', '\r'),
                  ('wait_for', 'Choose a model', 10), ('settle', 0.5), ('keys', '\x1b[D'), ('settle', 1.5)],
        'watch': [], 'final_contains': ['❯ Model'], 'never': ['finding Grok Build models'],
    },
    # A sign-in leaves one line saying how it went, never a "signing in"
    # line that stays.
    'sign-in-outcome': {
        'turns': [TWO_BLOCKS],
        'steps': [('type', 'please check the commit'), ('wait_for', 'The final commit is live.', 40), ('settle', 1)],
        'watch': [], 'final_contains': ['signed in to Grok Build'], 'never': ['signing in to Grok Build'],
    },
    # A command that prints while it runs: its newest lines show under the
    # spinner, and stay -- its first and last, the middle counted -- once a
    # completion that carries no output of its own settles the row.
    'streamed-tool-output': {
        'env': {'FAKE_DELAY_MS': '60'},
        'turns': [{'streamed_tool': {'lines': [f'test file {n} passed' for n in range(1, 9)], 'ms': 700}, 'blocks': ['All the tests pass.']}],
        'steps': [('type', 'run the tests'), ('wait_for', 'All the tests pass.', 40), ('settle', 2)],
        # Four columns in, under the call, while it runs and once it settles:
        # finishing never moves the output sideways.
        'watch': [], 'ever': ['\n    test file 3 passed'],
        'final_contains': ['\n    test file 1 passed', '\n    test file 8 passed', '3 lines hidden'],
        'never': ['\n      test file', '\n  test file'],
    },
    # Reasoning that names itself: its heading is what the status line says
    # while the model thinks.
    'thinking-heading-status': {
        'turns': [{'thought': {'text': '**Inspecting the parser** I should look at the tokens first.', 'ms': 2500},
                   'blocks': ['The parser is fine.']}],
        'steps': [('type', 'check the parser'), ('wait_for', 'The parser is fine.', 30), ('settle', 2)],
        'watch': ['check the parser', 'The parser is fine.'], 'ever': ['Inspecting the parser · ', '✻ I should look at the tokens first.'],
        # The reasoning row under it does not repeat the heading or its **.
        'never': ['**Inspecting', '✻ Inspecting'],
        # Once the answer begins the thought stays, settled, where it was had:
        # it never just vanishes.
        'final_contains': ['✻ Thought for '],
    },
    # Reads and searches in a row are one row while they happen, growing in
    # place and settling once -- never a row per call and then a merged copy
    # under them. A long command shows its first and last lines.
    'explore-run-merges': {
        'turns': [{'explore': [
            {'kind': 'read', 'title': 'Read src/a.ts', 'input': {'path': 'src/a.ts'}, 'result': '\n'.join(f'a{n}' for n in range(42))},
            {'kind': 'read', 'title': 'Read src/b.ts', 'input': {'path': 'src/b.ts'}, 'result': 'b0\nb1\nb2'},
            {'kind': 'search', 'title': 'Grep parseToken', 'input': {'pattern': 'parseToken'}, 'result': 'a.ts:1\nb.ts:2\nc.ts:3'},
        ], 'long_command': {'lines': [f'build step {n} of 30' for n in range(1, 31)]},
            'blocks': ['Explored and built.']}],
        'steps': [('type', 'look around and build'), ('wait_for', 'Explored and built.', 40), ('settle', 2)],
        'watch': ['look around and build', 'Explored and built.'],
        'ever': ['Reading src/a.ts', 'Reading 2 files'],
        'final_once': ['Read 2 files, searched 1 pattern', 'build step 1 of 30', 'build step 30 of 30', '25 lines hidden'],
        'never': ['build step 15 of 30'],
    },
    # Two approvals at once say which is which; the second is answered "no,
    # and do this instead": the call is denied and the words go to the turn.
    'approval-tell-instead': {
        'turns': [{'permissions': ['make clean', 'make release'], 'blocks': ['Answers: {answers}.']},
                  {'blocks': ['Releasing with pnpm now.']}],
        'steps': [
            ('type', 'clean and release'), ('wait_for', 'Approval 1 of 2', 30), ('settle', 0.6),
            ('keys', 'n'), ('wait_for', 'Approval 2 of 2', 10), ('settle', 0.6),
            ('keys', 't'), ('wait_for', 'type what it should do instead', 5),
            ('keys', 'use pnpm instead'), ('keys', '\r'),
            ('wait_for', 'Releasing with pnpm now.', 40), ('settle', 3),
        ],
        'watch': ['clean and release', 'Answers: reject, reject.', 'use pnpm instead', 'Releasing with pnpm now.'],
        # While an approval waits the line is a still dot and no clock.
        'ever': ['● waiting for you'],
    },
    # A long paste is a placeholder in the composer, and the whole text is
    # what is sent; the placeholder never reaches the transcript.
    'paste-placeholder': {
        'turns': [{'blocks': ['Paste received: {received}.']}],
        'steps': [
            ('keys', 'look at this '), ('keys', '\x1b[200~' + '\n'.join(f'pasted row {n}' for n in range(1, 13)) + '\x1b[201~'),
            ('wait_for', '[Pasted text #1 +12 lines]', 5), ('keys', '\r'),
            ('wait_for', 'Paste received:', 30), ('settle', 2),
        ],
        'watch': [], 'ever': ['› look at this [Pasted text #1 +12 lines]'], 'final_once': ['Paste received: whole.'],
        'final_contains': ['pasted row 12'],
    },
    # Enter on an empty composer with nothing waiting does nothing: the turn
    # runs to its end. "Enter again" only means stop & send once a message
    # is waiting with its row on screen.
    'enter-on-nothing-mid-answer': {
        'env': {'FAKE_DELAY_MS': '300'},
        'turns': [{'blocks': ['Step one of the long job.', 'Step two of the long job.', 'The long job is finished.']}],
        'steps': [
            ('type', 'start the long job'), ('wait_for', 'Step one of', 30),
            ('keys', '\r'), ('keys', '\r'),
            ('wait_for', 'The long job is finished.', 40), ('settle', 3),
        ],
        'watch': ['start the long job', 'The long job is finished.'],
        'never': ['stopping', 'enter again stop & send'],
    },
    # A message queued for after the turn (`/send queue`) into an agent that
    # takes steering: Enter again, nothing typed, puts it into the chat now.
    # The turn is not stopped and no second turn starts -- one row the whole
    # way.
    'send-queued-now': {
        'env': {'FAKE_STEERING': '1', 'FAKE_DELAY_MS': '300'},
        'turns': [{'blocks': ['Step one of the long job.', 'Step two of the long job.', 'The long job is finished.']},
                  {'blocks': ['The queued one answered now.']}],
        'steps': [
            ('type', '/send queue'), ('wait_for', 'Messages typed mid-turn: queue', 15),
            ('type', 'start the long job'), ('wait_for', 'Step one of', 30),
            ('type', 'then do this'), ('wait_for', 'enter again send into the chat', 10), ('keys', '\r'),
            ('wait_for', 'Steered in: then do this.', 40), ('settle', 3),
        ],
        'watch': ['start the long job', 'Steered in: then do this.'],
        'ever': ['sent into the turn'],
        'never': ['The queued one answered now.', 'stopping', 'Stopped'],
        'final_once': ['Steered in: then do this.'],
    },
    # Enter mid-turn into an agent that takes steering (Claude Code over
    # ACP): the message waits while a call runs -- a steer would interrupt it
    # -- and goes into the SAME turn the moment the call is done. The call
    # completes, the turn is never stopped, nothing becomes a second turn.
    'steer-at-next-pause': {
        'env': {'FAKE_STEERING': '1', 'FAKE_DELAY_MS': '150'},
        'turns': [{'intro': 'Starting the long build.', 'hold_ms': 6000, 'blocks': ['The build passed.']},
                  {'blocks': ['Queued turn answered.']}],
        'steps': [
            ('type', 'start the build'), ('wait_for', 'sleep 30', 30),
            ('type', 'also run the linter'), ('wait_for', 'sending at the next pause', 10),
            ('wait_for', 'Steered in: also run the linter.', 40), ('settle', 3),
        ],
        'watch': ['start the build', 'Steered in: also run the linter.'],
        'ever': ['sending at the next pause', 'sent into the turn'],
        # Held for the pause already: Enter again would do nothing, so it is
        # not offered.
        'never': ['Request interrupted', 'Queued turn answered.', 'stopping', 'enter again'],
        'final_once': ['Steered in: also run the linter.'],
    },
    # Esc on a waiting message takes it back into the composer to edit, and
    # touches nothing running: the held steer is never sent, the turn runs to
    # its end, nothing is stopped. Recorded: Esc to fix a just-sent message
    # stopped the turn and every sub-agent in it.
    'esc-takes-back-waiting-message': {
        'env': {'FAKE_STEERING': '1', 'FAKE_DELAY_MS': '150'},
        'turns': [{'intro': 'Starting the long build.', 'hold_ms': 6000, 'blocks': ['The build passed.']},
                  {'blocks': ['Queued turn answered.']}],
        'steps': [
            ('type', 'start the build'), ('wait_for', 'sleep 30', 30),
            ('type', 'also run the linter'), ('wait_for', 'esc edit', 10), ('settle', 0.5),
            ('keys', '\x1b'), ('wait_for', '› also run the linter', 10), ('snap', 'taken-back'),
            ('wait_for', 'The build passed.', 40), ('settle', 3),
        ],
        'watch': ['start the build', 'The build passed.'],
        # Still running: the waiting line names the open call's program; the
        # call's own row keeps the clock.
        'snap_contains': {'taken-back': ['running sleep']},
        'never': ['Steered in: also run the linter.', 'Queued turn answered.', 'stopping', 'Stopped'],
    },
    # Ctrl+C stops a turn, at any point.
    'ctrl-c-stops-turn': {
        'env': {'FAKE_DELAY_MS': '300'},
        'turns': [{'blocks': ['Step one of the long job.', 'Step two of the long job.', 'The long job is finished.']}],
        'steps': [
            ('type', 'start the long job'), ('wait_for', 'Step one of', 30),
            ('keys', '\x03'), ('wait_for', 'Stopped after', 15), ('settle', 2),
        ],
        'watch': ['start the long job', 'Step one of'],
        'never': ['The long job is finished.', 'Worked for'],
    },
    # Esc, nothing waiting, stops a turn that has started answering -- which
    # the waiting line says while it runs, as Claude Code's "esc to
    # interrupt" does. What it wrote stays.
    'esc-stops-answered-turn': {
        'env': {'FAKE_DELAY_MS': '300'},
        'turns': [{'blocks': ['Step one of the long job.', 'Step two of the long job.', 'The long job is finished.']}],
        'steps': [
            ('type', 'start the long job'), ('wait_for', 'Step one of', 30), ('settle', 0.5), ('snap', 'running'),
            ('keys', '\x1b'), ('wait_for', 'Stopped after', 15), ('settle', 2),
        ],
        'snap_contains': {'running': ['writing · ', ' · esc stop']},
        'watch': ['start the long job', 'Step one of'],
        'never': ['The long job is finished.', 'Worked for'],
        'final_contains': ['Stopped after'],
    },
    # A turn stopped under a running call reads as stopped, not finished:
    # the call's row says stopped, the turn ends on "Stopped after", and the
    # saved turn -- reopened by a fresh process -- says the same.
    'stopped-turn-reads-stopped': {
        'cols': 70, 'env': {'FAKE_DELAY_MS': '60'},
        'turns': [{'intro': 'Starting the long build.', 'hold_ms': 20000, 'blocks': ['The build passed.']}],
        'steps': [
            ('type', 'start the build'), ('wait_for', 'sleep 30', 30), ('settle', 1),
            ('keys', '\x03'), ('wait_for', 'Stopped after', 15), ('settle', 2), ('snap', 'stopped'),
            ('restart',), ('keys', '\x1b[D'), ('settle', 2), ('keys', '\r'), ('settle', 2.5),
        ],
        'watch': [],
        'snap_contains': {'stopped': ['■ $ sleep 30 stopped', 'Stopped after']},
        'final_contains': ['Starting the long build.', '■ $ sleep 30 stopped'],
        'final_once': ['$ sleep 30'],
        'never': ['Worked for', 'The build passed.'],
    },
    # `/send queue`: the same steering-capable agent, and the message waits
    # for the turn to end instead -- never steered in, never stopping it.
    'send-queue-mode': {
        'cols': 70, 'env': {'FAKE_STEERING': '1', 'FAKE_DELAY_MS': '150'},
        'turns': [{'intro': 'Starting the long build.', 'hold_ms': 4000, 'blocks': ['The build passed.']},
                  {'blocks': ['Queued turn answered.']}],
        'steps': [
            ('type', '/send queue'), ('wait_for', 'Messages typed mid-turn: queue', 15),
            ('type', 'start the build'), ('wait_for', 'Starting the long build.', 30),
            ('type', 'also run the linter'), ('wait_for', 'queued for next turn', 10),
            ('wait_for', 'The build passed.', 40), ('wait_for', 'Queued turn answered.', 40), ('settle', 3),
        ],
        'watch': ['start the build', 'also run the linter', 'Queued turn answered.'],
        # 70 columns hold one of the two keys: Esc's, which always works.
        'ever': ['queued for next turn · esc edit'],
        'never': ['Steered in: also run the linter.', 'sending at the next pause', 'sent into the turn', 'stopping'],
    },
    # The terminal around the UI: focus reports asked for and the shell's
    # title saved on the way in; progress while the turn runs; a notification
    # when it ends with the window unfocused for long enough; everything
    # handed back on the way out.
    'terminal-signals': {
        'env': {'FAKE_DELAY_MS': '400'},
        'turns': [TWO_BLOCKS],
        'steps': [
            ('type', 'please check the commit'), ('keys', '\x1b[O'),
            ('wait_for', 'The final commit is live.', 30), ('settle', 2),
        ],
        'watch': ['please check the commit', 'The final commit is live.'],
        'raw_in_order': ['\x1b[?1004h', '\x1b[22;0t', '\x1b]9;4;3;\x07', 'the turn has finished\x07\x07',
                         '\x1b]9;4;0;\x07', '\x1b[?1004l', '\x1b[23;0t'],
    },
    # A finished turn's tool calls are part of it: reopened -- from the board,
    # or by a fresh process -- every call is drawn again where it happened,
    # not a gap between paragraphs.
    'reopen-finished-turn-shows-tools': {
        'cols': 70, 'env': {'FAKE_TOOL_MS': '300', 'FAKE_DELAY_MS': '60'},
        'turns': [{'intro': 'Running the parts first.', 'tools_first': 4,
                   'blocks': ['The parts ran fine.', 'Then the commit was checked.']}],
        'steps': [
            ('type', 'run every part'), ('wait_for', 'Then the commit was checked.', 40), ('settle', 3),
            ('keys', '\x1b[D'), ('settle', 1.5), ('keys', '\r'), ('settle', 2.5), ('snap', 'board-and-back'),
            ('restart',), ('keys', '\x1b[D'), ('settle', 2), ('keys', '\r'), ('settle', 2.5),
        ],
        'watch': [],
        'snap_contains': {'board-and-back': ['Running the parts first.', 'part0 ok', 'part3 ok', 'abc123 fix', 'Then the commit was checked.']},
        'final_contains': ['Running the parts first.', 'part0 ok', 'part1 ok', 'part2 ok', 'part3 ok', 'abc123 fix', 'Then the commit was checked.',
                           # One blank row under a call's output, as above
                           # it: before the next call, and before the prose.
                           '    part0 ok'.ljust(70) + '\n' + ' ' * 70 + '\n  ▸ $ npx vitest run part1',
                           '    abc123 fix'.ljust(70) + '\n' + ' ' * 70 + '\n  Then the commit was checked.'],
        'final_once': ['part0 ok', 'part3 ok', 'abc123 fix'],
        'never': ['Interrupted turn activity'],
    },
    # The same turn opened by a fresh process while it runs: the calls it has
    # already made are on screen with the paragraph before them.
    'reopen-mid-turn-shows-tools': {
        'cols': 70, 'env': {'FAKE_TOOL_MS': '300', 'FAKE_DELAY_MS': '60'},
        'turns': [{'intro': 'Running the parts first.', 'tools_first': 4, 'hold_ms': 12000,
                   'blocks': ['The parts ran fine.', 'Then the commit was checked.']}],
        'steps': [
            ('type', 'run every part'), ('wait_for', 'sleep 30', 40), ('settle', 1),
            ('restart',), ('keys', '\x1b[D'), ('settle', 2), ('keys', '\r'), ('settle', 2.5), ('snap', 'rejoined'),
            ('wait_for', 'Then the commit was checked.', 40), ('settle', 3),
        ],
        'watch': [],
        'snap_contains': {'rejoined': ['Running the parts first.', 'part0 ok', 'part3 ok']},
        'final_contains': ['Running the parts first.', 'part0 ok', 'part3 ok', 'held call done', 'abc123 fix', 'Then the commit was checked.'],
        'final_once': ['part0 ok', 'part3 ok', 'held call done'],
        'never': ['Interrupted turn activity'],
    },
    # /search: the conversation with the most mentions opens at its first
    # one -- far above what the screen shows -- highlighted; Down walks to
    # the next, Tab to the next conversation, Esc stays there.
    'search-walks-mentions': {
        'cols': 80, 'env': {'FAKE_DELAY_MS': '5'},
        'turns': [{'blocks': ['Zebra protocol starts here.', '\n\n'.join(f'Filler paragraph {n} of the long answer.' for n in range(1, 40)),
                              'The zebra protocol again, near the end.']},
                  {'blocks': ['One zebra protocol here.']}],
        'steps': [
            ('type', 'explain the zebra protocol'), ('wait_for', 'near the end.', 40), ('settle', 2),
            ('keys', '\x1b[D'), ('settle', 2),
            ('type', 'another zebra protocol question'), ('wait_for', 'One zebra protocol here.', 30), ('settle', 2),
            ('type', '/search zebra protocol'), ('wait_for', 'mention 1 of 3', 15), ('settle', 1), ('snap', 'first'),
            ('reversed', 'zebra protocol'),
            ('keys', '\x1b[B'), ('wait_for', 'mention 2 of 3', 10), ('settle', 1), ('snap', 'second'),
            ('keys', '\x1b[B'), ('wait_for', 'mention 3 of 3', 10), ('settle', 1), ('snap', 'last'),
            ('keys', '\t'), ('wait_for', 'chat 2 of 2', 10), ('settle', 1), ('snap', 'next-chat'),
            ('keys', '\x1b'), ('settle', 2), ('mark',),
        ],
        'watch': [],
        'snap_contains': {
            'first': ['explain the zebra protocol', 'mention 1 of 3 · chat 1 of 2 · ↑↓ next/previous · tab next chat · esc done'],
            'second': ['Zebra protocol starts here.'],
            'last': ['The zebra protocol again, near the end.'],
            'next-chat': ['One zebra protocol here.', 'another zebra protocol question'],
        },
        'final_contains': ['One zebra protocol here.'],
        'never_after_mark': ['↑↓ next/previous'],
    },
    # A search nothing matches says so and stays.
    'search-no-match-stays': {
        'turns': [{'blocks': ['Plain answer stays put.']}],
        'steps': [
            ('type', 'a plain question'), ('wait_for', 'Plain answer stays put.', 30), ('settle', 1),
            ('type', '/search quokka'), ('wait_for', 'No conversation mentions "quokka"', 10), ('settle', 1),
        ],
        'watch': [], 'final_contains': ['Plain answer stays put.', 'No conversation mentions "quokka"'],
    },
    # A long turn whose rows overflow the screen: a wheel notch back moves the
    # WHOLE transcript area -- its newest rows leave at the bottom -- and Esc
    # brings them back. It used to move only the top rows.
    'long-turn-scroll-moves-whole-screen': {
        'cols': 70, 'rows': 40, 'env': {'FAKE_TOOL_MS': '150', 'FAKE_DELAY_MS': '40'},
        'turns': [{'intro': 'Running every part now.', 'tools_first': 30, 'hold_ms': 25000, 'blocks': ['All thirty parts pass.']}],
        'steps': [
            ('type', 'run every part'), ('wait_for', 'sleep 30', 40), ('settle', 1.5), ('snap', 'before'),
            *[step for _ in range(5) for step in (('keys', '\x1b[<64;35;20M'), ('settle', 0.4))], ('settle', 1), ('snap', 'scrolled'),
            ('keys', '\x1b'), ('settle', 1.5), ('snap', 'back'),
        ],
        'watch': [], 'scroll_moves': {'pattern': r'part(\d+) ok'},
        'never': ['Interrupted turn activity'],
    },
    # A phone with its keyboard up sends a swipe as arrow keys only: Up with
    # nothing typed must scroll a running turn back, as it does at the prompt.
    # Recorded: during a long turn the keyboard came up and every swipe after
    # that did nothing.
    'long-turn-swipe-arrows-scroll': {
        'cols': 70, 'rows': 32, 'env': {'FAKE_TOOL_MS': '150', 'FAKE_DELAY_MS': '40'},
        'turns': [{'intro': 'Running every part now.', 'tools_first': 30, 'hold_ms': 25000, 'blocks': ['All thirty parts pass.']}],
        'steps': [
            ('type', 'run every part'), ('wait_for', 'sleep 30', 40), ('settle', 1.5), ('snap', 'before'),
            *[step for _ in range(4) for step in (('keys', '\x1b[A'), ('settle', 0.4))], ('settle', 1), ('snap', 'scrolled'),
            ('keys', '\x1b'), ('settle', 1.5), ('snap', 'back'),
        ],
        'watch': [], 'scroll_moves': {'pattern': r'part(\d+) ok'},
        'never': ['Interrupted turn activity'],
    },
    # The same in a window that joined the running turn (out to the board and
    # back), where the whole turn so far arrives at once.
    'joined-turn-scroll-moves-whole-screen': {
        'cols': 70, 'rows': 40, 'env': {'FAKE_TOOL_MS': '150', 'FAKE_DELAY_MS': '40'},
        'turns': [{'intro': 'Running every part now.', 'tools_first': 30, 'hold_ms': 25000, 'blocks': ['All thirty parts pass.']}],
        'steps': [
            ('type', 'run every part'), ('wait_for', 'sleep 30', 40), ('settle', 1),
            ('keys', '\x1b[D'), ('settle', 1.5), ('keys', '\r'), ('settle', 2.5), ('snap', 'before'),
            *[step for _ in range(5) for step in (('keys', '\x1b[<64;35;20M'), ('settle', 0.4))], ('settle', 1), ('snap', 'scrolled'),
            ('keys', '\x1b'), ('settle', 1.5), ('snap', 'back'),
        ],
        'watch': [], 'scroll_moves': {'pattern': r'part(\d+) ok'},
        'never': ['Interrupted turn activity'],
    },
    # Out of usage on the only account: the Resume-in picker offers to wait
    # for the reset; chosen, the status line says so until Esc stops it.
    'wait-for-reset': {
        'turns': [{'refuse': 'The monthly usage limit has been reached. Try again in 2 hours.', 'blocks': ['unused']}],
        'steps': [
            ('type', 'please check the commit'), ('wait_for', 'Wait for reset (', 30), ('settle', 1),
            ('keys', '\r'), ('wait_for', 'waiting for reset ·', 15), ('settle', 1), ('snap', 'waiting'),
            ('keys', '\x1b'), ('wait_for', 'Stopped waiting for the reset', 10), ('settle', 3), ('mark',), ('settle', 16),
        ],
        # Stopped: neither the status line nor a redraw brings it back.
        'never_after_mark': ['waiting for reset ·'],
        'watch': [],
        'ever': ['All accounts exhausted · back', 'Esc or a new message cancels'],
        'snap_contains': {'waiting': ['waiting for reset ·']},
        'final_contains': ['Stopped waiting for the reset'],
    },
    # Typing in the palette highlights the best match: `/c` and `/co` used
    # to highlight /account (its group came first) over /compact and /copy.
    'palette-best-match-first': {
        'turns': [TWO_BLOCKS],
        'steps': [('keys', '/c'), ('settle', 1), ('snap', 'c'), ('keys', 'o'), ('settle', 1), ('snap', 'co')],
        'watch': [], 'snap_contains': {'c': ['❯ /c'], 'co': ['❯ /co']}, 'snap_lacks': {'c': ['❯ /account'], 'co': ['❯ /account']},
    },
    # Effort moved to High in its row, then Tab → "Make default for every
    # harness": the value saved is the one shown (it saved the value Settings
    # opened with), and Settings stays open on the row (it closed).
    'settings-default-saves-shown-value': {
        'turns': [TWO_BLOCKS],
        'steps': [('keys', '/settings'), ('settle', 1), ('keys', '\r'), ('wait_for', 'Swarm', 10), ('settle', 0.5),
                  *[step for _ in range(4) for step in (('keys', '\x1b[B'), ('settle', 0.3))],
                  ('keys', '4'), ('settle', 0.5), ('keys', '\t'), ('wait_for', 'Make default for every harness', 10), ('settle', 0.5),
                  ('keys', '\x1b[B'), ('settle', 0.3), ('keys', '\r'), ('wait_for', 'Default saved', 10), ('settle', 1.5), ('snap', 'after'),
                  ('keys', '\x1b'), ('settle', 1)],
        'watch': [], 'final_contains': ['Default saved · Effort for every harness: high'],
        'snap_contains': {'after': ['❯ Effort', '● High']}, 'never': ['for every harness: medium'],
    },
    # Esc on a one-line question ("Conversation name ›", "File to attach ›")
    # cancels it: the next thing typed is a message again, not its answer.
    'esc-cancels-one-line-question': {
        'turns': [{'blocks': ['Answered after the questions were cancelled.']}],
        'steps': [('type', '/rename'), ('wait_for', 'Conversation name', 10), ('settle', 0.5), ('keys', '\x1b'), ('settle', 1),
                  ('type', '/mention'), ('wait_for', 'File to attach', 10), ('settle', 0.5), ('keys', '\x1b'), ('settle', 1),
                  ('type', 'hello again'), ('wait_for', 'Answered after the questions were cancelled.', 30), ('settle', 2)],
        'watch': [], 'final_contains': ['› hello again'], 'never': ['ENOENT', 'Error:'],
    },
    # A notice wraps (up to three rows) rather than being cut to one: at 70
    # columns /export's notice kept its file name only in the middle of a
    # long path, and /model's error lost the list of valid models.
    'notices-wrap-at-70-cols': {
        'cols': 70,
        'turns': [{'blocks': ['Hello there, all good.']}],
        'steps': [('type', 'hi'), ('wait_for', 'Hello there, all good.', 30), ('settle', 2),
                  ('type', '/export'), ('wait_for', 'Transcript written', 10), ('settle', 1), ('snap', 'export'),
                  ('type', '/model nosuch-model'), ('settle', 3), ('snap', 'model')],
        'watch': [], 'snap_contains': {'export': ['.md'], 'model': ['grok-4-fast']},
    },
    # /status draws the current setup: it used to draw nothing at all.
    'status-shows-setup': {
        'turns': [TWO_BLOCKS],
        'steps': [('type', '/status'), ('wait_for', 'Current setup', 10), ('settle', 1)],
        'watch': [], 'final_contains': ['Current setup', 'provider', 'Grok Build', 'permissions'],
    },
    # /usage all: every provider, then the days with use: today's row has its
    # one turn, and no tokens or cost (the fake reports none) -- never $0, and
    # never a field that only says it is unknown.
    'usage-all': {
        'turns': [{'blocks': ['Hello there, all good.']}],
        'steps': [('type', 'hi'), ('wait_for', 'Hello there, all good.', 30), ('settle', 2),
                  ('type', '/usage all'), ('wait_for', 'Last 7 days', 10), ('settle', 1)],
        'watch': [], 'final_contains': ['Grok Build', 'Last 7 days', '1 turn'], 'never': ['$0.00', 'unknown'],
    },
    # /fork with no N: a picker of the user's messages, newest first; the fork
    # after message 1 holds only that exchange, and says files are not rewound.
    'fork-at-message': {
        'turns': [{'blocks': ['ALPHA answer lives here.']}, {'blocks': ['BETA answer lives here.']}],
        'steps': [
            ('type', 'first question'), ('wait_for', 'ALPHA answer lives here.', 30), ('settle', 2),
            ('type', 'second question'), ('wait_for', 'BETA answer lives here.', 30), ('settle', 2),
            ('type', '/fork'), ('wait_for', 'Fork after which message?', 10), ('settle', 0.5),
            ('keys', '\x1b[B'), ('settle', 0.5), ('keys', '\r'), ('wait_for', 'Forked after message 1', 10), ('mark',), ('settle', 2),
        ],
        'watch': [], 'ever': ['2  second question', '1  first question'],
        'final_contains': ['first question', 'ALPHA answer lives here.', 'files on disk are not rewound'],
        'never_after_mark': ['BETA answer lives here.'],
    },
    # /changes lists the turn's edit, /changes 1 shows its diff, /undo 1 puts
    # the file back.
    'changes-and-undo': {
        'turns': [{'edits': [{'path': 'notes.txt', 'old': 'alpha\nbeta\n', 'new': 'alpha\nGAMMA\n'}], 'blocks': ['Edited the notes.']}],
        'steps': [
            ('type', 'edit the notes'), ('wait_for', 'Edited the notes.', 30), ('settle', 2),
            ('type', '/changes'), ('wait_for', 'notes.txt · +1 -1', 10), ('settle', 1), ('keys', '\x1b'), ('settle', 1),
            ('type', '/changes 1'), ('wait_for', '+ GAMMA', 10), ('settle', 1), ('keys', '\x1b'), ('settle', 1),
            ('type', '/undo 1'), ('wait_for', 'restored  notes.txt', 10), ('settle', 1),
        ],
        'watch': [], 'ever': ['1  edit the notes', 'Turn 1 · edit the notes', '- beta'],
        'file_contains': {'notes.txt': 'alpha\nbeta\n'},
    },
    # `!<command>`: its output is a transcript message, drawn once, with no
    # notice repeating how it exited.
    'shell-line-in-transcript': {
        'turns': [{'blocks': ['Hello there, all good.']}],
        'steps': [('type', 'hi'), ('wait_for', 'Hello there, all good.', 30), ('settle', 2),
                  ('type', '!echo shell-out-$((40+2))'), ('wait_for', 'shell-out-42', 10), ('settle', 2)],
        'watch': ['shell-out-42'], 'final_contains': ['!echo shell-out-$((40+2))', 'exit 0'], 'never': ['rides into the next request'],
    },
    # No alternate screen: the first message still signs in, on the plain
    # terminal (login.ts plainSignInScreen), then answers.
    'classic-fallback': {
        'classic': True,
        'turns': [{'blocks': ['The final commit is live.']}],
        'steps': [('type', 'please check the commit'), ('wait_for', 'The final commit is live.', 30)],
        'watch': [], 'final_contains': ['The final commit is live.'],
        'ever': ['accounts.x.ai/oauth2/device'], 'never': ['is not signed in'],
    },
}


def run(name, spec, entry, keep):
    root = tempfile.mkdtemp(prefix=f'clikcode-e2e-{name}-')
    if spec.get('rebuild_entry'):
        installed = os.path.join(root, 'installed')
        shutil.copytree(os.path.dirname(entry), installed)
        os.symlink(os.path.join(REPO, 'node_modules'), os.path.join(root, 'node_modules'))
        entry = os.path.join(installed, os.path.basename(entry))
    home, state, fakebin, workspace = (os.path.join(root, part) for part in ('home', 'state', 'bin', 'work'))
    for path in (home, state, fakebin, workspace): os.makedirs(path)
    binary = spec.get('harness', 'grok')
    shutil.copy(os.path.join(REPO, 'scripts', 'tui-e2e', 'fake-grok.mjs'), os.path.join(fakebin, binary))
    os.chmod(os.path.join(fakebin, binary), 0o755)
    node = os.path.realpath(shutil.which('node'))
    # Node, npm and npx alone, not the directory they live in: a vendor CLI
    # installed globally beside node (opencode, 2026-10-06) was on the
    # scenario's PATH, and ClikCode chose it over the fake.
    nodebin = os.path.join(root, 'node-bin')
    os.makedirs(nodebin)
    for tool in ('node', 'npm', 'npx'):
        found = os.path.join(os.path.dirname(node), tool)
        if os.path.exists(found): os.symlink(found, os.path.join(nodebin, tool))
    # Its own npm prefix: a harness ClikCode installs during a scenario (an
    # ACP adapter) must land in the scenario, never in the global node_modules
    # of the node running it.
    npm_prefix = os.path.join(root, 'npm')
    env = {
        'PATH': ':'.join([fakebin, os.path.join(npm_prefix, 'bin'), nodebin, '/usr/bin', '/bin']),
        'npm_config_prefix': npm_prefix,
        'HOME': home, 'CLIKCODE_HOME': state, 'TERM': 'xterm-256color', 'LANG': 'C.UTF-8',
        'FAKE_TURNS': json.dumps(spec['turns']), 'FAKE_STATE': os.path.join(root, 'turn-counter'),
        'FAKE_FAMILY': spec.get('family', 'claude'), 'FAKE_LOG': os.path.join(root, 'argv.log'),
        **spec.get('env', {}),
        # Remote, so a copy goes to the terminal by OSC 52 -- which this
        # harness can read back out of the output -- and never to a real
        # clipboard binary on the machine running the test.
        'SSH_CONNECTION': '127.0.0.1 1 127.0.0.1 22',
    }
    if spec.get('classic'): env['CLIKCODE_TUI'] = 'classic'
    # The fake sign-in waits on the browser for as long as this file exists.
    sign_in_hold = os.path.join(root, 'login-hold')
    if spec.get('hold_sign_in'):
        open(sign_in_hold, 'w').close()
        env['FAKE_LOGIN_HOLD'] = sign_in_hold
    cols = spec.get('cols', COLS)
    rows = spec.get('rows', ROWS)

    def launch(args=()):
        child, terminal = pty.fork()
        if child == 0:
            os.chdir(workspace)
            os.execve(node, ['node', entry, *args], env)
        fcntl.ioctl(terminal, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
        return child, terminal

    pid, fd = launch()
    screen = Screen(cols, rows)
    stream = ByteStream(screen)
    snaps = {}
    raw, frames = bytearray(), []
    # A second window ('open2'): another ClikCode on the same CLIKCODE_HOME,
    # in its own pty and on its own screen, as a second terminal would be.
    pid2, fd2 = None, None
    screen2 = Screen(cols, rows)
    stream2 = ByteStream(screen2)
    raw2, frames2 = bytearray(), []
    # A window whose process has gone (its pty hung up) is not read again.
    closed = {1: False, 2: False}
    start = time.time()

    def pump(seconds, until=None, which=1):
        """Read both windows for `seconds`, or until `until` is on window
        `which`'s screen. False when that window has gone."""
        end = time.time() + seconds
        while time.time() < end:
            if closed[which] and until is not None: return False
            open_fds = [f for f, n in ((fd, 1), (fd2, 2)) if f is not None and not closed[n]]
            if not open_fds: return False
            ready, _, _ = select.select(open_fds, [], [], 0.05)
            for ready_fd in ready:
                n = 1 if ready_fd == fd else 2
                try: chunk = os.read(ready_fd, 65536)
                except OSError: chunk = b''
                if not chunk:
                    closed[n] = True
                    continue
                if n == 1:
                    raw.extend(chunk); stream.feed(chunk)
                    frames.append((time.time() - start, '\n'.join(screen.display)))
                else:
                    raw2.extend(chunk); stream2.feed(chunk)
                    frames2.append((time.time() - start, '\n'.join(screen2.display)))
            shown = frames if which == 1 else frames2
            if until and shown and until in shown[-1][1]: return True
        return until is None

    def worker_pids():
        """The pids the conversation workers' records name, alive or not."""
        workers = os.path.join(state, 'workers')
        found = []
        for record in (os.listdir(workers) if os.path.isdir(workers) else []):
            if not record.endswith('.json'): continue
            try: found.append(json.load(open(os.path.join(workers, record)))['pid'])
            except (OSError, ValueError, KeyError): pass
        return found

    def alive(process):
        try: os.kill(process, 0); return True
        except OSError: return False

    problems = []
    pump(spec.get('startup', 5))
    typed_at = None
    typed_raw_at = None
    marked_at = None
    marked2_at = None
    for step in spec['steps']:
        if step[0] == 'open2':
            # A second window on the same conversations, opened now; with
            # ['--continue'] it opens the latest one.
            pid2, fd2 = launch(step[2] if len(step) > 2 else ())
            closed[2] = False
            pump(step[1] if len(step) > 1 else 5)
        elif step[0] == 'type2':
            for ch in step[1]: os.write(fd2, ch.encode()); pump(0.02)
            os.write(fd2, b'\r')
            pump(0.3)
        elif step[0] == 'keys2':
            os.write(fd2, step[1].encode()); pump(0.3)
        elif step[0] == 'wait_for2':
            if not pump(step[2], step[1], 2): problems.append(f'window 2 timed out waiting for {step[1]!r}')
        elif step[0] == 'snap2':
            snaps[step[1]] = list(screen2.display)
        elif step[0] == 'mark2':
            # Where 'never2' starts looking.
            marked2_at = len(frames2)
        elif step[0] == 'kill_workers':
            # Every conversation worker, by the signal named ('KILL', 'TERM').
            for worker in worker_pids():
                try: os.kill(worker, getattr(signal, f'SIG{step[1]}'))
                except OSError: pass
            pump(0.3)
        elif step[0] == 'expect_workers':
            # Exactly this many workers running, within a few seconds.
            deadline = time.time() + (step[2] if len(step) > 2 else 10)
            running = [worker for worker in worker_pids() if alive(worker)]
            while len(running) != step[1] and time.time() < deadline:
                pump(0.2)
                running = [worker for worker in worker_pids() if alive(worker)]
            if len(running) != step[1]: problems.append(f'{len(running)} worker(s) running, expected {step[1]}')
        elif step[0] == 'type':
            if typed_raw_at is None: typed_raw_at = len(raw)
            for ch in step[1]: os.write(fd, ch.encode()); pump(0.02)
            os.write(fd, b'\r')
            if typed_at is None: typed_at = time.time() - start
            pump(0.3)
        elif step[0] == 'type_slow':
            # As 'type', one key every step[2] seconds: typing that spans
            # something finishing underneath it.
            if typed_raw_at is None: typed_raw_at = len(raw)
            for ch in step[1]: os.write(fd, ch.encode()); pump(step[2])
            os.write(fd, b'\r')
            if typed_at is None: typed_at = time.time() - start
            pump(0.3)
        elif step[0] == 'release_sign_in':
            if 'waiting for you to sign in' not in '\n'.join(screen.display):
                problems.append('the sign-in had finished before it was released')
            os.remove(sign_in_hold)
        elif step[0] == 'keys':
            os.write(fd, step[1].encode()); pump(0.3)
        elif step[0] == 'wait_for':
            if not pump(step[2], step[1]): problems.append(f'timed out waiting for {step[1]!r}')
        elif step[0] == 'settle':
            pump(step[1])
        elif step[0] == 'mark':
            # Where 'never_after_mark' starts looking.
            marked_at = len(frames)
        elif step[0] == 'snap':
            # The screen as it is now, kept under a name for the checks below.
            snaps[step[1]] = list(screen.display)
        elif step[0] == 'restart':
            # The window closes (its terminal hangs up) and a fresh process
            # opens on a fresh screen. Workers it started keep running.
            try: os.kill(pid, signal.SIGHUP)
            except ProcessLookupError: pass
            deadline = time.time() + 5
            while time.time() < deadline:
                try:
                    if os.waitpid(pid, os.WNOHANG)[0] == pid: break
                except ChildProcessError: break
                pump(0.05)
            try: os.close(fd)
            except OSError: pass
            pid, fd = launch()
            closed[1] = False
            screen.reset()
            pump(step[1] if len(step) > 1 else 5)
        elif step[0] == 'reversed':
            # The phrase is on screen with every one of its cells in inverse
            # video (a /search match), case-insensitively.
            wanted = step[1].lower()
            found = False
            for row in range(screen.lines):
                line = ''.join(screen.buffer[row][col].data for col in range(screen.columns))
                at = line.lower().find(wanted)
                while at >= 0 and not found:
                    found = all(screen.buffer[row][col].reverse for col in range(at, at + len(wanted)) if line[col] != ' ')
                    at = line.lower().find(wanted, at + 1)
            if not found: problems.append(f'not highlighted on screen: {step[1]!r}')
        elif step[0] == 'touch_entry':
            os.utime(entry, None)
        elif step[0] == 'damage_and_redraw':
            # Simulate cells lost by the client: the app's cached frame is still
            # intact, but the emulated display is blank. Ctrl+L must rebuild it.
            stream.feed(b'\x1b[2J')
            before = len(raw)
            os.write(fd, b'\x0c')
            pump(0.6)
            if b'\x1b[2J' not in raw[before:]: problems.append('Ctrl+L did not force a full repaint')
            if step[1] not in '\n'.join(screen.display):
                problems.append(f'Ctrl+L did not restore {step[1]!r}')
        elif step[0] == 'resize_burst':
            # Keyboard close on the phone changes the reported height several
            # times before settling. Keep the real PTY and emulator in lockstep.
            before = len(raw)
            for lines in (63, 40, 32):
                fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', lines, 70, 0, 0))
                screen.resize(lines=lines, columns=70)
                pump(0.05)
            pump(0.5)
            # The scroll fix for a phone with its keyboard hidden: after a
            # resize, all four mouse modes, then hide, clear and home, then
            # the rows -- as Claude Code sends it there. Without the clear,
            # a swipe stopped scrolling.
            settled = b'\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h\x1b[?25l\x1b[?7l\x1b[2J\x1b[H'
            deadline = time.time() + 3
            while settled not in bytes(raw[before:]) and time.time() < deadline: pump(0.1)
            if settled not in bytes(raw[before:]):
                problems.append('after a resize: not the mouse modes, then a clear and home, before the redraw')
            mouse_reset = b'\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h'
            resets = raw[before:].count(mouse_reset)
            if resets != 1: problems.append(f'resize burst sent {resets} mouse resets, expected one')
        elif step[0] == 'quiet':
            # Nothing on screen changes, so nothing may be written: a frame
            # that changes nothing used to toggle the cursor regardless.
            before = len(raw)
            pump(step[1])
            if len(raw) != before: problems.append(f'wrote {len(raw) - before} bytes while nothing changed: {bytes(raw[before:before + 80])!r}')
        elif step[0] == 'resize':
            fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', step[1], step[2], 0, 0))
            screen.resize(lines=step[1], columns=step[2])
            pump(0.5)
        elif step[0] == 'select':
            # Press on the phrase's first cell, drag across it, release on its
            # last -- the mouse reports a terminal sends with SGR reporting on.
            where = [(row, line.find(step[1])) for row, line in enumerate(screen.display) if step[1] in line]
            if not where:
                problems.append(f'could not find {step[1]!r} on screen to select'); continue
            row, col = where[-1]
            first, last = col + 1, col + len(step[1])
            os.write(fd, f'\x1b[<0;{first};{row + 1}M'.encode()); pump(0.05)
            for x in range(first + 1, last + 1, 4):
                os.write(fd, f'\x1b[<32;{x};{row + 1}M'.encode()); pump(0.03)
            os.write(fd, f'\x1b[<32;{last};{row + 1}M'.encode()); pump(0.05)
            os.write(fd, f'\x1b[<0;{last};{row + 1}m'.encode()); pump(0.3)
    final = frames[-1][1] if frames else ''
    final2 = frames2[-1][1] if frames2 else ''
    # The second window goes first, so nothing it does on its way out lands
    # on the first window's final screen.
    if pid2 is not None:
        try: os.kill(pid2, signal.SIGTERM)
        except ProcessLookupError: pass
        deadline = time.time() + 5
        while time.time() < deadline:
            try:
                if os.waitpid(pid2, os.WNOHANG)[0] == pid2: break
            except ChildProcessError: break
            pump(0.05)
        try: os.close(fd2)
        except OSError: pass
        fd2, closed[2] = None, True
    for _ in range(2):
        try: os.write(fd, b'\x03')
        except OSError: pass
        pump(0.4)
    try: os.kill(pid, signal.SIGTERM)
    except ProcessLookupError: pass
    # Session workers are spawned detached and outlive the TUI by their idle
    # timeout (30 minutes); every one this run started is stopped here.
    stopped = []
    for worker in worker_pids():
        try: os.kill(worker, signal.SIGTERM); stopped.append(worker)
        except OSError: pass
    # Gone before the directory is removed: an exiting process still writes
    # into it (its compile cache, its record), and would leave it behind.
    deadline = time.time() + 5
    while time.time() < deadline:
        try:
            if os.waitpid(pid, os.WNOHANG)[0] == pid: pid = -1
        except ChildProcessError: pid = -1
        if pid == -1 and not [worker for worker in stopped if alive(worker)]: break
        time.sleep(0.05)

    watched = [(t, text) for t, text in frames if typed_at is not None and t >= typed_at]
    for phrase in spec['watch']:
        seen = [i for i, (_, text) in enumerate(watched) if phrase in text]
        if not seen:
            problems.append(f'never shown: {phrase!r}'); continue
        gone = [watched[i][0] for i in range(seen[0], len(watched)) if phrase not in watched[i][1]]
        if gone: problems.append(f'VANISHED {phrase!r}: in {len(gone)} frame(s) after first showing, first at {gone[0]:.2f}s')
        if final.count(phrase) != 1: problems.append(f'on screen {final.count(phrase)}x at the end, expected once: {phrase!r}')
    for turn in spec['turns']:
        for left, right in zip(turn['blocks'], turn['blocks'][1:]):
            if left + right.split()[0] in final: problems.append(f'jammed with no paragraph break: {left!r} / {right!r}')
    for phrase in spec.get('never', []):
        shown = [t for t, text in frames if phrase in text]
        if shown: problems.append(f'shown in {len(shown)} frame(s), first at {shown[0]:.2f}s, and never should be: {phrase!r}')
    for phrase in spec.get('ever', []):
        if not any(phrase in text for _, text in frames): problems.append(f'never on screen: {phrase!r}')
    for left, right in spec.get('never_together', []):
        both = [t for t, text in frames if left in text and right in text]
        if both: problems.append(f'{left!r} and {right!r} on screen together in {len(both)} frame(s), first at {both[0]:.2f}s')
    # Scrolling back moves the whole transcript area: the newest rows leave
    # it at the bottom, and Esc brings exactly them back.
    if 'scroll_moves' in spec:
        import re as regex
        pattern = regex.compile(spec['scroll_moves']['pattern'])
        def newest(name):
            found = [int(m.group(1)) for line in snaps.get(name, []) for m in pattern.finditer(line)]
            return max(found) if found else None
        def bottom(name):
            lines = [line.rstrip() for line in snaps.get(name, [])]
            # The waiting line: the two-cell braille spinner, then its words.
            band = next((i for i, line in enumerate(lines) if regex.match(r'\s*[\u2800-\u28ff]{2}  ', line)), len(lines))
            return [line for line in lines[max(0, band - 12):band] if line.strip() and not regex.search(r'\(\d+s\)|\d+m \d+s| · \d+s$', line)]
        before, scrolled, back = newest('before'), newest('scrolled'), newest('back')
        if before is None: problems.append('scroll check: nothing matching the pattern on screen before scrolling')
        elif scrolled is not None and scrolled >= before:
            problems.append(f'scrolled back, the newest row is still on screen (newest {scrolled}, before {before}): the bottom of the transcript did not move')
        if back != before: problems.append(f'after Esc the newest row is {back}, expected {before}')
        if bottom('before') and bottom('before') == bottom('scrolled'):
            problems.append('scrolled back, the bottom rows of the transcript area are unchanged: ' + ' | '.join(bottom('before')[-3:]))
    for name, phrases in spec.get('snap_contains', {}).items():
        shown = '\n'.join(snaps.get(name, []))
        for phrase in phrases:
            if phrase not in shown: problems.append(f'not on the {name!r} screen: {phrase!r}')
    for name, text in spec.get('file_contains', {}).items():
        try: found = open(os.path.join(workspace, name)).read()
        except OSError: found = None
        if found != text: problems.append(f'{name} holds {found!r}, expected {text!r}')
    for phrase in spec.get('final_contains', []):
        if phrase not in final: problems.append(f'expected on the final screen: {phrase!r}')
    for phrase in spec.get('final_once', []):
        if final.count(phrase) != 1: problems.append(f'on screen {final.count(phrase)}x at the end, expected once: {phrase!r}')
    for name, phrases in spec.get('snap_lacks', {}).items():
        shown = '\n'.join(snaps.get(name, []))
        for phrase in phrases:
            if phrase in shown: problems.append(f'on the {name!r} screen, and never should be: {phrase!r}')
    for name, phrases in spec.get('snap_once', {}).items():
        shown = '\n'.join(snaps.get(name, []))
        for phrase in phrases:
            if shown.count(phrase) != 1: problems.append(f'on the {name!r} screen {shown.count(phrase)}x, expected once: {phrase!r}')
    for phrase in spec.get('final2_contains', []):
        if phrase not in final2: problems.append(f'expected on window 2\'s final screen: {phrase!r}')
    for phrase in spec.get('final2_once', []):
        if final2.count(phrase) != 1: problems.append(f'on window 2\'s screen {final2.count(phrase)}x at the end, expected once: {phrase!r}')
    for phrase in spec.get('never2', []):
        shown = [t for t, text in frames2[marked2_at or 0:] if phrase in text]
        if shown: problems.append(f'shown on window 2 in {len(shown)} frame(s), first at {shown[0]:.2f}s, and never should be: {phrase!r}')
    for phrase in spec.get('ever_after_mark', []):
        if not any(phrase in text for _, text in frames[marked_at or 0:]): problems.append(f'never on screen after the mark: {phrase!r}')
    for phrase in spec.get('never_after_mark', []):
        shown = [t for t, text in frames[marked_at or 0:] if phrase in text]
        if shown: problems.append(f'shown in {len(shown)} frame(s) after the mark, first at {shown[0]:.2f}s: {phrase!r}')
    # Sequences the screen never shows (title, progress, focus, a
    # notification), in the order they must have been written.
    at = 0
    for sequence in spec.get('raw_in_order', []):
        found = bytes(raw).find(sequence.encode(), at)
        if found < 0: problems.append(f'not written (after what came before it): {sequence!r}')
        else: at = found + len(sequence)
    # The session's modes are on at the end, whatever happened on the way:
    # each was asked for after it was last switched off. A hand-over (a `!`
    # command, a picker that leaves the screen) switches them all off, and
    # coming back must switch them on again -- the mouse modes are what make
    # a phone swipe scroll, bracketed paste what keeps a pasted newline from
    # sending. 'modes_off_at_end' names any scenario that leaves them off.
    # Only for the full-screen UI: classic mode asks for none of them.
    if not spec.get('modes_off_at_end') and b'\x1b[?1049h' in bytes(raw):
        # Up to the exit's own teardown, which leaves the alternate screen
        # last and rightly switches everything off.
        # That teardown switches the mouse off on the alternate screen, leaves
        # it, and switches it off again: cut where it starts.
        tail = bytes(raw)
        leave = tail.rfind(b'\x1b[?1049l')
        if leave >= 0:
            start = tail.rfind(b'\x1b[?1006l\x1b[?1016l', 0, leave)
            tail = tail[:start if 0 <= start and leave - start < 200 else leave]
        for mode in ('1000', '1002', '1003', '1006', '2004'):
            on, off = tail.rfind(f'\x1b[?{mode}h'.encode()), tail.rfind(f'\x1b[?{mode}l'.encode())
            if on < 0 or on < off: problems.append(f'mode ?{mode} is off at the end (last switched off, never on again)')
    for sequence in spec.get('raw_never', []):
        if sequence.encode() in bytes(raw): problems.append(f'written, and never should be: {sequence!r}')
    if spec.get('no_clear_after_type') and typed_raw_at is not None and b'\x1b[2J' in raw[typed_raw_at:]:
        problems.append('screen cleared after the turn started')
    if 'clipboard' in spec:
        import base64, re as regex
        copies = [base64.b64decode(m).decode('utf-8', 'replace') for m in regex.findall(rb'\x1b\]52;c;([A-Za-z0-9+/=]*)\x07', bytes(raw))]
        if not copies: problems.append('nothing reached the clipboard (no OSC 52 in the output)')
        elif copies[-1] != spec['clipboard']: problems.append(f'clipboard got {copies[-1]!r}, expected {spec["clipboard"]!r}')


    open(os.path.join(root, 'capture.bin'), 'wb').write(bytes(raw))
    open(os.path.join(root, 'final.txt'), 'w').write(final)
    if frames2: open(os.path.join(root, 'final2.txt'), 'w').write(final2)
    if keep or problems:
        # Every distinct screen, timed: the way to see which draw did it.
        for name, shots in (('frames.txt', frames), ('frames2.txt', frames2)):
            if not shots: continue
            with open(os.path.join(root, name), 'w') as log:
                last = None
                for t, text in shots:
                    if text == last: continue
                    last = text
                    log.write(f'===== {t:.2f}s\n' + '\n'.join(line.rstrip() for line in text.split('\n') if line.strip()) + '\n')
    if not problems and not keep: shutil.rmtree(root, ignore_errors=True)
    return problems, root, final


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('entry', nargs='?', default=os.path.join(REPO, 'dist', 'index.js'))
    parser.add_argument('--repeat', type=int, default=1)
    parser.add_argument('--only')
    parser.add_argument('--keep', action='store_true')
    args = parser.parse_args()
    entry = os.path.abspath(args.entry)
    failed = 0
    for name, spec in SCENARIOS.items():
        if args.only and name not in args.only.split(','): continue
        for attempt in range(1, args.repeat + 1):
            problems, root, final = run(name, spec, entry, args.keep)
            status = 'PASS' if not problems else 'FAIL'
            print(f'{status}  {name}  [{attempt}/{args.repeat}]' + ('' if not problems else f'  capture: {root}'))
            for problem in problems: print(f'        - {problem}')
            if problems:
                failed += 1
                print('        final screen:\n' + '\n'.join(f'          {line.rstrip()}' for line in final.split('\n') if line.strip()))
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()
