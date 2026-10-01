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

TWO_BLOCKS = {'blocks': ['Checking the workspace first.', 'The final commit is live.']}

# Each step: ('type', text) types and presses Enter; ('wait_for', text, secs)
# waits until text is on screen; ('settle', secs) lets the screen quiet down.
SCENARIOS = {
    'two-blocks-with-tool': {
        'turns': [TWO_BLOCKS],
        'steps': [('type', 'please check the commit'), ('wait_for', 'The final commit is live.', 30), ('settle', 4)],
        'watch': ['please check the commit', 'Checking the workspace first.', 'The final commit is live.'],
        # A turn that ran a tool ends on one line saying so, written once.
        'final_once': ['Worked for'],
        # Never looked away from: no notification.
        'raw_never': ['the turn has finished'],
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
        'cols': 70, 'env': {'FAKE_TOOL_MS': '1500'},
        'turns': [{'tools_first': 10, 'blocks': ['All ten parts pass.']}],
        'steps': [
            ('type', 'run every part'), ('wait_for', 'esc to interrupt', 30), ('settle', 4),
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
            ('type', 'run every part'), ('wait_for', 'esc to interrupt', 30), ('settle', 4),
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
    # The slash menu, a step at a time. Choosing a command that takes a value
    # opens its own titled picker -- the typed command gone, never left under
    # it -- starting on the current value, and the change is confirmed.
    'slash-command-opens-picker': {
        'turns': [TWO_BLOCKS],
        'steps': [('keys', '/effort'), ('settle', 1), ('keys', '\r'), ('wait_for', 'Reasoning effort', 10), ('settle', 0.5),
                  ('keys', '\x1b[B'), ('settle', 0.5), ('keys', '\r'), ('wait_for', 'Effort set to High', 10)],
        'watch': [], 'ever': ['❯ Medium  · current', 'Effort set to High'],
        'never_together': [('› /effort', 'Reasoning effort'), ('Tab complete · Enter run', 'Reasoning effort')],
    },
    # What runs is what is highlighted: a typed command starts highlighted,
    # and its picker replaces it.
    'typed-command-highlighted': {
        'turns': [TWO_BLOCKS],
        'steps': [('keys', '/account'), ('settle', 1), ('keys', '\r'), ('wait_for', 'Grok Build accounts', 10), ('settle', 1)],
        'watch': [], 'ever': ['❯ /account'],
        'never_together': [('› /account', 'Grok Build accounts'), ('Tab complete · Enter run', 'Grok Build accounts')],
    },
    # Back from a sub-menu lands on the row it was opened from, with no
    # spinner or empty composer flashed on the way into the list.
    'settings-back-lands-on-row': {
        'turns': [TWO_BLOCKS],
        'steps': [('keys', '/settings'), ('settle', 1), ('keys', '\r'), ('wait_for', 'Failover', 10), ('settle', 0.5),
                  ('keys', '\x1b[B'), ('settle', 0.3), ('keys', '\x1b[B'), ('settle', 0.5), ('keys', '\r'),
                  ('wait_for', 'Choose a model', 10), ('settle', 0.5), ('keys', '\x1b[D'), ('settle', 1.5)],
        'watch': [], 'final_contains': ['❯ Model'], 'never': ['finding Grok Build models'],
    },
    # A sign-in leaves one line saying how it went, never a "signing in"
    # line that stays.
    'sign-in-outcome': {
        'turns': [TWO_BLOCKS],
        'steps': [('settle', 1)],
        'watch': [], 'final_contains': ['signed in to Grok Build'], 'never': ['signing in to Grok Build'],
    },
    # A command that prints while it runs: its newest lines show under the
    # spinner, and stay -- its first and last, the middle counted -- once a
    # completion that carries no output of its own settles the row.
    'streamed-tool-output': {
        'env': {'FAKE_DELAY_MS': '60'},
        'turns': [{'streamed_tool': {'lines': [f'test file {n} passed' for n in range(1, 9)], 'ms': 700}, 'blocks': ['All the tests pass.']}],
        'steps': [('type', 'run the tests'), ('wait_for', 'All the tests pass.', 40), ('settle', 2)],
        'watch': [], 'ever': ['test file 3 passed'],
        'final_contains': ['test file 1 passed', 'test file 8 passed', '3 lines hidden'],
    },
    # Reasoning that names itself: its heading is what the status line says
    # while the model thinks.
    'thinking-heading-status': {
        'turns': [{'thought': {'text': '**Inspecting the parser** I should look at the tokens first.', 'ms': 2500},
                   'blocks': ['The parser is fine.']}],
        'steps': [('type', 'check the parser'), ('wait_for', 'The parser is fine.', 30), ('settle', 2)],
        'watch': ['check the parser', 'The parser is fine.'], 'ever': ['Inspecting the parser ('],
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
    # Ctrl+S mid-turn: what is typed stops the turn and is sent as the next
    # one at once -- one row the whole way, from the composer to its prompt.
    'send-now-mid-answer': {
        'env': {'FAKE_DELAY_MS': '300'},
        'turns': [{'blocks': ['Step one of the long job.', 'Step two of the long job.', 'The long job is finished.']},
                  {'blocks': ['Sent now and answered.']}],
        'steps': [
            ('type', 'start the long job'), ('wait_for', 'Step one of', 30),
            ('keys', 'do this instead'), ('wait_for', 'ctrl+s to send now', 5), ('keys', '\x13'),
            ('wait_for', 'Sent now and answered.', 40), ('settle', 3),
        ],
        'watch': ['start the long job', 'do this instead', 'Sent now and answered.'],
        'ever': ['sending now'], 'never': ['The long job is finished.'],
    },
    # With nothing typed, Ctrl+S sends the message already queued.
    'send-queued-now': {
        'env': {'FAKE_DELAY_MS': '300'},
        'turns': [{'blocks': ['Step one of the long job.', 'Step two of the long job.', 'The long job is finished.']},
                  {'blocks': ['The queued one answered now.']}],
        'steps': [
            ('type', 'start the long job'), ('wait_for', 'Step one of', 30),
            ('type', 'then do this'), ('wait_for', 'ctrl+s sends now', 10), ('keys', '\x13'),
            ('wait_for', 'The queued one answered now.', 40), ('settle', 3),
        ],
        'watch': ['start the long job', 'then do this', 'The queued one answered now.'],
        'never': ['The long job is finished.'],
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
    'classic-fallback': {
        'classic': True,
        'turns': [{'blocks': ['The final commit is live.']}],
        'steps': [('type', 'please check the commit'), ('wait_for', 'The final commit is live.', 30)],
        'watch': [], 'final_contains': ['The final commit is live.'],
    },
}


def run(name, spec, entry, keep):
    root = tempfile.mkdtemp(prefix=f'clikcode-e2e-{name}-')
    home, state, fakebin, workspace = (os.path.join(root, part) for part in ('home', 'state', 'bin', 'work'))
    for path in (home, state, fakebin, workspace): os.makedirs(path)
    binary = spec.get('harness', 'grok')
    shutil.copy(os.path.join(REPO, 'scripts', 'tui-e2e', 'fake-grok.mjs'), os.path.join(fakebin, binary))
    os.chmod(os.path.join(fakebin, binary), 0o755)
    node = os.path.realpath(shutil.which('node'))
    # Its own npm prefix: a harness ClikCode installs during a scenario (an
    # ACP adapter) must land in the scenario, never in the global node_modules
    # of the node running it.
    npm_prefix = os.path.join(root, 'npm')
    env = {
        'PATH': ':'.join([fakebin, os.path.join(npm_prefix, 'bin'), os.path.dirname(node), '/usr/bin', '/bin']),
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
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(workspace)
        os.execve(node, ['node', entry], env)
    cols = spec.get('cols', COLS)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', ROWS, cols, 0, 0))
    screen = pyte.Screen(cols, ROWS)
    stream = pyte.ByteStream(screen)
    raw, frames = bytearray(), []
    start = time.time()

    def pump(seconds, until=None):
        end = time.time() + seconds
        while time.time() < end:
            ready, _, _ = select.select([fd], [], [], 0.05)
            if ready:
                try: chunk = os.read(fd, 65536)
                except OSError: return False
                if not chunk: return False
                raw.extend(chunk); stream.feed(chunk)
                frames.append((time.time() - start, '\n'.join(screen.display)))
            if until and frames and until in frames[-1][1]: return True
        return until is None

    problems = []
    pump(spec.get('startup', 5))
    typed_at = None
    for step in spec['steps']:
        if step[0] == 'type':
            for ch in step[1]: os.write(fd, ch.encode()); pump(0.02)
            os.write(fd, b'\r')
            if typed_at is None: typed_at = time.time() - start
            pump(0.3)
        elif step[0] == 'keys':
            os.write(fd, step[1].encode()); pump(0.3)
        elif step[0] == 'wait_for':
            if not pump(step[2], step[1]): problems.append(f'timed out waiting for {step[1]!r}')
        elif step[0] == 'settle':
            pump(step[1])
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
    for _ in range(2): os.write(fd, b'\x03'); pump(0.4)
    try: os.kill(pid, signal.SIGTERM)
    except ProcessLookupError: pass
    # Session workers are spawned detached and outlive the TUI by their idle
    # timeout (30 minutes); every one this run started is stopped here.
    workers = os.path.join(state, 'workers')
    stopped = []
    for record in (os.listdir(workers) if os.path.isdir(workers) else []):
        if not record.endswith('.json'): continue
        try:
            worker = json.load(open(os.path.join(workers, record)))['pid']
            os.kill(worker, signal.SIGTERM); stopped.append(worker)
        except (OSError, ValueError, KeyError): pass
    # Gone before the directory is removed: an exiting process still writes
    # into it (its compile cache, its record), and would leave it behind.
    deadline = time.time() + 5
    while time.time() < deadline:
        try:
            if os.waitpid(pid, os.WNOHANG)[0] == pid: pid = -1
        except ChildProcessError: pid = -1
        def running(worker):
            try: os.kill(worker, 0); return True
            except OSError: return False
        alive = [worker for worker in stopped if running(worker)]
        if pid == -1 and not alive: break
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
    for phrase in spec.get('final_contains', []):
        if phrase not in final: problems.append(f'expected on the final screen: {phrase!r}')
    for phrase in spec.get('final_once', []):
        if final.count(phrase) != 1: problems.append(f'on screen {final.count(phrase)}x at the end, expected once: {phrase!r}')
    # Sequences the screen never shows (title, progress, focus, a
    # notification), in the order they must have been written.
    at = 0
    for sequence in spec.get('raw_in_order', []):
        found = bytes(raw).find(sequence.encode(), at)
        if found < 0: problems.append(f'not written (after what came before it): {sequence!r}')
        else: at = found + len(sequence)
    for sequence in spec.get('raw_never', []):
        if sequence.encode() in bytes(raw): problems.append(f'written, and never should be: {sequence!r}')
    if 'clipboard' in spec:
        import base64, re as regex
        copies = [base64.b64decode(m).decode('utf-8', 'replace') for m in regex.findall(rb'\x1b\]52;c;([A-Za-z0-9+/=]*)\x07', bytes(raw))]
        if not copies: problems.append('nothing reached the clipboard (no OSC 52 in the output)')
        elif copies[-1] != spec['clipboard']: problems.append(f'clipboard got {copies[-1]!r}, expected {spec["clipboard"]!r}')


    open(os.path.join(root, 'capture.bin'), 'wb').write(bytes(raw))
    open(os.path.join(root, 'final.txt'), 'w').write(final)
    if keep or problems:
        # Every distinct screen, timed: the way to see which draw did it.
        with open(os.path.join(root, 'frames.txt'), 'w') as log:
            last = None
            for t, text in frames:
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
        if args.only and args.only != name: continue
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
