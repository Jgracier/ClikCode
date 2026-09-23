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
    'model-changed-mid-answer': {
        'turns': [TWO_BLOCKS],
        'steps': [
            ('type', 'please check the commit'), ('wait_for', 'Checking the workspace first.', 30),
            ('type', '/model grok-4-fast'), ('wait_for', 'The final commit is live.', 30), ('settle', 4),
        ],
        'watch': ['please check the commit', 'Checking the workspace first.', 'The final commit is live.'],
        'final_contains': ['grok-4-fast'],
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
    env = {
        'PATH': ':'.join([fakebin, os.path.dirname(node), '/usr/bin', '/bin']),
        'HOME': home, 'CLIKCODE_HOME': state, 'TERM': 'xterm-256color', 'LANG': 'C.UTF-8',
        'FAKE_TURNS': json.dumps(spec['turns']), 'FAKE_STATE': os.path.join(root, 'turn-counter'),
        'FAKE_FAMILY': spec.get('family', 'claude'),
    }
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(workspace)
        os.execve(node, ['node', entry], env)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', ROWS, COLS, 0, 0))
    screen = pyte.Screen(COLS, ROWS)
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
    pump(5)
    typed_at = None
    for step in spec['steps']:
        if step[0] == 'type':
            for ch in step[1]: os.write(fd, ch.encode()); pump(0.02)
            os.write(fd, b'\r')
            if typed_at is None: typed_at = time.time() - start
            pump(0.3)
        elif step[0] == 'wait_for':
            if not pump(step[2], step[1]): problems.append(f'timed out waiting for {step[1]!r}')
        elif step[0] == 'settle':
            pump(step[1])
    final = frames[-1][1] if frames else ''
    for _ in range(2): os.write(fd, b'\x03'); pump(0.4)
    try: os.kill(pid, signal.SIGTERM)
    except ProcessLookupError: pass

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
    for phrase in spec.get('final_contains', []):
        if phrase not in final: problems.append(f'expected on the final screen: {phrase!r}')

    open(os.path.join(root, 'capture.bin'), 'wb').write(bytes(raw))
    open(os.path.join(root, 'final.txt'), 'w').write(final)
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
