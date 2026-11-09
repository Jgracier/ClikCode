#!/usr/bin/env python3
"""Resize / terminal-behaviour matrix for the TUI: the real program in a real pty (or in tmux), its output played into a
real terminal emulator (@xterm/headless, or tmux's own screen), judged after every settle against the layout invariants
in check.mjs: the composer and status are the last rows, no stale block, no blank run inside the conversation or pushed
into scrollback, no history lost or repeated, no row wider than the screen. No real vendor is ever run: a fake one
(../fake-grok.mjs) plays the turns, in a throwaway HOME.

    node scripts/build.mjs
    python3 scripts/tui-e2e/resize-matrix/matrix.py [--only NAME] [--emu xterm|xterm-no3j|xterm-mute|tmux] [--mode inline|full|auto] [--keep]

Exit status 0 when every checked snapshot holds every invariant."""
import argparse, base64, fcntl, json, os, pty, select, shutil, signal, struct, subprocess, sys, tempfile, termios, time

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
from state_guard import refuse_real_state
ENTRY = os.environ.get('MATRIX_ENTRY', os.path.join(REPO, 'dist/index.js'))  # the build under test
SETTLE = 1.2  # RESIZE_SETTLE_MS is 100; a cursor report that is never answered times out after 300 ms (xterm-mute)

def marker_block(first, last, extra=''):
    return '\n'.join(f'- H{n:03d} marker line{extra}' for n in range(first, last + 1))

WIDE = ' 日本語 🎉 ok'

# Each scenario: start size, turns the fake vendor plays, and steps. Steps:
#   ('type', text) types text and Enter   ('rapid', n, text) does that n times, one turn each   ('keys', bytes)   ('wait', text, seconds)   ('settle', seconds)
#   ('resize', cols, rows)   ('burst', [(cols, rows), ...], gap)   ('check', label, {opts}, markers (first, last) or None)
# What a change of height alone may cost: the live block's rows, no more, and not one row of the conversation.
BOUNDED = {'maxBytes': 3000, 'maxHistoryRows': 0, 'measure': True, 'sameAs': 'start 35', 'turns': True}

BOARD = {'noBlock': True, 'noHistory': True, 'board': True, 'surface': 'page', 'keeps': 'start'}
BOARD_RESIZED = {**BOARD, 'keeps': None}

SCENARIOS = {
    # A conversation longer than the screen, the screen growing and shrinking the way a phone's keyboard does it.
    'rows-grow-shrink': dict(size=(69, 35), turns=[{'blocks': [marker_block(1, 70)]}], steps=[
        ('type', 'go'), ('wait', 'H070', 40), ('settle', 1.5), ('check', 'start 35', {}, (1, 70)),
        ('resize', 69, 67), ('settle', SETTLE), ('check', 'grow 67', {}, (1, 70)),
        ('resize', 69, 35), ('settle', SETTLE), ('check', 'shrink 35', {}, (1, 70)),
        ('resize', 69, 67), ('settle', SETTLE), ('check', 'grow 67 again', {}, (1, 70)),
        ('resize', 69, 50), ('settle', SETTLE), ('check', 'shrink 50', {}, (1, 70)),
        ('resize', 69, 20), ('settle', SETTLE), ('check', 'shrink 20', {}, (1, 70)),
        ('resize', 69, 67), ('settle', SETTLE), ('check', 'grow 67 from 20', {}, (1, 70)),
    ]),
    # A phone's keyboard, again and again, over a long conversation (500 messages): a height change re-anchors the live
    # block only. What it writes is bounded by the block (not by the conversation) and none of it is a history row.
    'toggle-500': dict(size=(69, 35), turns=[{'blocks': [marker_block(first, first + 9)]} for first in range(1, 501, 10)], steps=[
        ('rapid', 51, 'go'), ('wait', 'H500', 60), ('settle', 2), ('check', 'start 35', {'turns': True}, (1, 500)),
    ] + [step for n in range(4) for step in (
        ('resize', 69, 67), ('settle', SETTLE), ('check', f'keyboard hides {n + 1}: 35 to 67', BOUNDED, (1, 500)),
        ('resize', 69, 35), ('settle', SETTLE), ('check', f'keyboard shows {n + 1}: 67 to 35', BOUNDED, (1, 500)))]),
    # The same over a conversation that fits on one screen: the blank rows above it are the screen's, the toggle writes the block only.
    'toggle-short': dict(size=(69, 35), turns=[{'blocks': [marker_block(1, 12)]}], steps=[
        ('type', 'go'), ('wait', 'H012', 40), ('settle', 1.5), ('check', 'start 35', {}, (1, 12)),
    ] + [step for n in range(3) for step in (
        ('resize', 69, 67), ('settle', SETTLE), ('check', f'keyboard hides {n + 1}: 35 to 67', BOUNDED, (1, 12)),
        ('resize', 69, 35), ('settle', SETTLE), ('check', f'keyboard shows {n + 1}: 67 to 35', BOUNDED, (1, 12)))]),
    # A conversation shorter than the screen: the blank rows above it are the screen's, never scrollback.
    'short-grow-shrink': dict(size=(69, 35), turns=[{'blocks': [marker_block(1, 6)]}], steps=[
        ('type', 'go'), ('wait', 'H006', 40), ('settle', 1.5), ('check', 'start 35', {}, (1, 6)),
        ('resize', 69, 67), ('settle', SETTLE), ('check', 'grow 67', {}, (1, 6)),
        ('resize', 69, 35), ('settle', SETTLE), ('check', 'shrink 35', {}, (1, 6)),
        ('resize', 69, 12), ('settle', SETTLE), ('check', 'shrink 12', {}, (1, 6)),
        ('resize', 69, 67), ('settle', SETTLE), ('check', 'grow 67', {}, (1, 6)),
    ]),
    # Nothing said yet: the empty composer, resized.
    'empty-grow-shrink': dict(size=(69, 35), turns=[{'blocks': ['x']}], steps=[
        ('settle', 1.5), ('check', 'start', {'noHistory': True}, None),
        ('resize', 69, 67), ('settle', SETTLE), ('check', 'grow', {'noHistory': True}, None),
        ('resize', 69, 35), ('settle', SETTLE), ('check', 'shrink', {'noHistory': True}, None),
    ]),
    # The keyboard sliding: several sizes inside one settle.
    'keyboard-burst': dict(size=(69, 67), turns=[{'blocks': [marker_block(1, 80)]}], steps=[
        ('type', 'go'), ('wait', 'H080', 40), ('settle', 1.5), ('check', 'start 67', {}, (1, 80)),
        ('burst', [(69, 60), (69, 52), (69, 44), (69, 38), (69, 35)], 0.05), ('settle', SETTLE), ('check', 'burst down', {}, (1, 80)),
        ('burst', [(69, 40), (69, 48), (69, 56), (69, 64), (69, 67)], 0.05), ('settle', SETTLE), ('check', 'burst up', {}, (1, 80)),
    ]),
    # Columns: wrapped again, both ways; wide characters and emoji in the history.
    'columns': dict(size=(69, 35), turns=[{'blocks': [marker_block(1, 60, WIDE)]}], steps=[
        ('type', 'go'), ('wait', 'H060', 40), ('settle', 1.5), ('check', 'start 69', {}, (1, 60)),
        ('resize', 100, 35), ('settle', SETTLE), ('check', 'wider 100', {}, (1, 60)),
        ('resize', 50, 35), ('settle', SETTLE), ('check', 'narrower 50', {}, (1, 60)),
        ('resize', 69, 67), ('settle', SETTLE), ('check', 'back 69x67', {}, (1, 60)),
        ('resize', 40, 20), ('settle', SETTLE), ('check', '40x20', {}, (1, 60)),
        ('resize', 69, 35), ('settle', SETTLE), ('check', '69x35', {}, (1, 60)),
    ]),
    # Tiny sizes and back.
    'tiny': dict(size=(69, 35), turns=[{'blocks': [marker_block(1, 40)]}], steps=[
        ('type', 'go'), ('wait', 'H040', 40), ('settle', 1.5),
        ('resize', 30, 8), ('settle', SETTLE), ('check', '30x8', {'noHistory': True}, None),
        ('resize', 20, 6), ('settle', SETTLE), ('check', '20x6', {'noHistory': True}, None),
        ('resize', 69, 35), ('settle', SETTLE), ('check', 'back 69x35', {'noHistory': True}, None),
    ]),
    # A turn streaming while the screen changes, then done.
    'streaming': dict(size=(69, 35), env={'FAKE_DELAY_MS': '60'},
        turns=[{'emits': [{'op': 'text', 'text': marker_block(n, n) + '\n', 'ms': 60} for n in range(1, 61)]}], steps=[
        ('type', 'go'), ('wait', 'H010', 40),
        ('resize', 69, 67), ('settle', 0.8), ('resize', 69, 35), ('settle', 0.8), ('resize', 69, 67),
        ('wait', 'H060', 60), ('settle', 2), ('check', 'after stream at 67', {}, (1, 60)),
        ('resize', 69, 35), ('settle', SETTLE), ('check', 'shrink 35', {}, (1, 60)),
        ('resize', 69, 67), ('settle', SETTLE), ('check', 'grow 67', {}, (1, 60)),
    ]),
    # The palette open (a list in the live block) while the screen changes.
    'palette': dict(size=(69, 35), turns=[{'blocks': [marker_block(1, 60)]}], steps=[
        ('type', 'go'), ('wait', 'H060', 40), ('settle', 1.5),
        ('check', 'start', {}, (1, 60)),
        ('keys', '/'), ('settle', 0.8), ('check', 'palette open', BOARD, None),
        ('resize', 69, 67), ('settle', SETTLE), ('check', 'palette grow', BOARD_RESIZED, None),
        ('resize', 69, 35), ('settle', SETTLE), ('check', 'palette shrink', BOARD_RESIZED, None),
        ('keys', '\x7f'), ('settle', 1), ('check', 'palette closed', {}, (1, 60)),
        ('resize', 69, 50), ('settle', SETTLE), ('check', 'closed, 50', {}, (1, 60)),
    ]),
    # The conversation board (left arrow on an empty composer).
    'board': dict(size=(69, 35), turns=[{'blocks': [marker_block(1, 60)]}], steps=[
        ('type', 'go'), ('wait', 'H060', 40), ('settle', 1.5),
        ('check', 'start', {}, (1, 60)),
        ('keys', '\x1b[D'), ('settle', 2), ('check', 'board open', BOARD, None),
        ('resize', 69, 67), ('settle', SETTLE), ('check', 'board grow', BOARD_RESIZED, None),
        ('resize', 69, 35), ('settle', SETTLE), ('check', 'board shrink', BOARD_RESIZED, None),
    ]),
    # The board over a long conversation and 70 earlier ones: a surface of its own (the whole visible screen, no chat above or
    # below it), the scrollback kept while it is open, the conversation exactly as it was when it closes.
    'board-long': dict(size=(69, 35), seed=70, turns=[{'blocks': [marker_block(1, 80)]}], steps=[
        ('type', 'go'), ('wait', 'H080', 40), ('settle', 1.5), ('check', 'start', {}, (1, 80)),
        ('keys', '\x1b[D'), ('settle', 2), ('check', 'board open', BOARD, (1, 80)),
        ('keys', '\x1b'), ('settle', 2), ('check', 'board closed', {'sameAs': 'start'}, (1, 80)),
        ('keys', '\x1b[D'), ('settle', 2), ('check', 'board open again', BOARD, (1, 80)),
        ('resize', 69, 67), ('settle', SETTLE), ('check', 'board grow', BOARD_RESIZED, (1, 80)),
        ('resize', 69, 35), ('settle', SETTLE), ('check', 'board shrink', BOARD_RESIZED, (1, 80)),
        ('keys', '\x1b'), ('settle', 2), ('check', 'closed after resize', {'sameAs': 'start'}, (1, 80)),
    ]),
    # The same while a turn is running: its frames keep arriving under the board.
    'board-turn': dict(size=(69, 35), seed=70, turns=[{'blocks': [marker_block(1, 80)], 'hold_ms': 25000}], steps=[
        ('type', 'go'), ('wait', 'H080', 40), ('settle', 1.5), ('check', 'start', {'turns': True}, (1, 80)),
        ('keys', '\x1b[D'), ('settle', 2), ('check', 'board open', BOARD, (1, 80)),
        ('resize', 69, 67), ('settle', SETTLE), ('check', 'board grow', BOARD_RESIZED, (1, 80)),
        ('resize', 69, 35), ('settle', SETTLE), ('check', 'board shrink', BOARD_RESIZED, (1, 80)),
    ]),
    # Ctrl+Z to the shell and back, the screen another size on the way back.
    'suspend': dict(size=(69, 35), turns=[{'blocks': [marker_block(1, 60)]}], steps=[
        ('type', 'go'), ('wait', 'H060', 40), ('settle', 1.5), ('check', 'start', {}, (1, 60)),
        ('suspend', 69, 50), ('settle', 1.5), ('check', 'resumed at 50', {}, (1, 60)),
        ('resize', 69, 35), ('settle', SETTLE), ('check', 'shrink 35', {}, (1, 60)),
    ]),
}

def child_env(root, mode, turns, extra):
    home, state, fakebin, nodebin = (os.path.join(root, p) for p in ('home', 'state', 'bin', 'nb'))
    for path in (home, state, fakebin, nodebin, os.path.join(root, 'work')): os.makedirs(path, exist_ok=True)
    shutil.copy(os.path.join(REPO, 'scripts/tui-e2e/fake-grok.mjs'), os.path.join(fakebin, 'grok')); os.chmod(os.path.join(fakebin, 'grok'), 0o755)
    os.symlink(os.path.join(REPO, 'scripts/tui-e2e/fake-tailscale.mjs'), os.path.join(fakebin, 'tailscale'))
    node = os.path.realpath(shutil.which('node'))
    for tool in ('node', 'npm', 'npx'):
        found = os.path.join(os.path.dirname(node), tool)
        if os.path.exists(found): os.symlink(found, os.path.join(nodebin, tool))
    env = {'PATH': f'{fakebin}:{nodebin}:/usr/bin:/bin', 'HOME': refuse_real_state(home), 'CLIKCODE_HOME': refuse_real_state(state), 'TERM': 'xterm-256color', 'LANG': 'C.UTF-8',
           'FAKE_TURNS': json.dumps(turns), 'FAKE_STATE': os.path.join(root, 'ctr'), 'FAKE_FAMILY': 'claude', 'FAKE_LOG': os.path.join(root, 'argv.log'), 'FAKE_DELAY_MS': '8'}
    if mode == 'inline': env['CLIKCODE_INLINE'] = '1'
    elif mode == 'full': env['CLIKCODE_INLINE'] = '0'
    else: env.update({'SSH_CONNECTION': '127.0.0.1 1 127.0.0.1 22'})  # what an SSH client gives: no TERM_PROGRAM, no CLIKDEPLOY_CLIENT
    env.update(extra)
    return env, node

def seed_conversations(root, count, env, node):
    """`count` earlier conversations in the throwaway HOME's index, so the board has a long list to show. The program is run once
    first (it signs the fake vendor in on its first turn), then the earlier conversations are added to the index it wrote."""
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(os.path.join(root, 'work')); os.execve(node, ['node', ENTRY], env)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 35, 69, 0, 0))
    def pump(seconds):
        end = time.time() + seconds
        while time.time() < end:
            if select.select([fd], [], [], 0.05)[0]:
                try: os.read(fd, 65536)
                except OSError: return
    pump(4); os.write(fd, b'hi'); pump(0.3); os.write(fd, b'\r'); pump(6)
    try: os.kill(pid, signal.SIGKILL); os.waitpid(pid, 0)
    except (ProcessLookupError, ChildProcessError): pass
    path = os.path.join(root, 'state', 'index.json')
    index = json.load(open(path))
    template = index['sessions'][0]
    now = time.time()
    for n in range(count):
        stamp = time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime(now - 3600 * (n + 1) * 2))
        sid = f'00000000-0000-4000-8000-{n:012d}'
        index['sessions'].append({**template, 'id': sid, 'conversationId': sid, 'createdAt': stamp, 'updatedAt': stamp, 'listPreview': f'older question number {n}',
                                  'name': f'Conversation {n:02d} about something', 'nativeSessionId': None})
    json.dump(index, open(path, 'w'))
    shutil.rmtree(os.path.join(root, 'ctr'), ignore_errors=True)
    if os.path.exists(os.path.join(root, 'ctr')): os.remove(os.path.join(root, 'ctr'))

class Emulator:
    """A live terminal (emulate.mjs) fed every byte the program writes; what it answers (a cursor position report) goes back to the pty."""
    def __init__(self, variant, size):
        self.proc = subprocess.Popen(['node', os.path.join(HERE, 'emulate.mjs'), variant], stdin=subprocess.PIPE, stdout=subprocess.PIPE, cwd=REPO)
        self.out = self.proc.stdout.fileno()
        os.set_blocking(self.out, False)
        self.buffer = b''
        self.snaps = None
        self.send({'k': 'init', 'c': size[0], 'r': size[1]})
    def send(self, event): self.proc.stdin.write((json.dumps(event) + '\n').encode()); self.proc.stdin.flush()
    def events(self):
        try: chunk = os.read(self.out, 1 << 22)
        except BlockingIOError: chunk = b''
        self.buffer += chunk
        *done, self.buffer = self.buffer.split(b'\n')
        return [json.loads(line) for line in done if line]

class Pty:
    """The program in a pty; every byte and every resize goes to the emulator, and its answers come back."""
    def __init__(self, root, env, node, size, emulator):
        self.emulator = emulator
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            os.chdir(os.path.join(root, 'work'))
            os.execve(node, ['node', ENTRY], env)
        self.size(*size)
        self.text = ''
    def size(self, cols, rows):
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
        self.emulator.send({'k': 'resize', 'c': cols, 'r': rows})
    def drain(self):
        for event in self.emulator.events():
            if event['k'] == 'reply': os.write(self.fd, base64.b64decode(event['d']))
            else: self.emulator.snaps = event['snaps']
    def pump(self, seconds, until=None):
        end = time.time() + seconds
        while time.time() < end:
            ready, _, _ = select.select([self.fd, self.emulator.out], [], [], 0.02)
            self.drain()
            if self.fd not in ready: continue
            try: chunk = os.read(self.fd, 65536)
            except OSError: return False
            if not chunk: return False
            self.emulator.send({'k': 'out', 'd': base64.b64encode(chunk).decode()})
            self.text = (self.text + chunk.decode('utf8', 'replace'))[-20000:]
            if until and until in self.text: return True
        return until is None
    def send(self, data): os.write(self.fd, data.encode())

def run_xterm(name, spec, mode, variant, keep):
    root = tempfile.mkdtemp(prefix=f'resize-matrix-{name}-')
    env, node = child_env(root, mode, spec['turns'], spec.get('env', {}))
    if spec.get('seed'): seed_conversations(root, spec['seed'], env, node)
    checks = []
    emulator = Emulator(variant, spec['size'])
    term = Pty(root, env, node, spec['size'], emulator)
    term.pump(4)
    for step in spec['steps']:
        op = step[0]
        if op == 'type': term.send(step[1]); term.pump(0.2); term.send('\r'); term.pump(0.3)
        elif op == 'rapid':
            for _ in range(step[1]): term.send(step[2]); term.pump(0.1); term.send('\r'); term.pump(0.9)
        elif op == 'keys': term.send(step[1]); term.pump(0.3)
        elif op == 'wait': term.pump(step[2], until=step[1])
        elif op == 'settle': term.pump(step[1])
        elif op == 'resize': term.size(step[1], step[2]); term.pump(0.05)
        elif op == 'burst':
            for cols, rows in step[1]: term.size(cols, rows); term.pump(step[2])
        elif op == 'suspend':
            term.send('\x1a'); term.pump(1.0)
            try: os.waitpid(term.pid, os.WUNTRACED | os.WNOHANG)
            except ChildProcessError: pass
            term.size(step[1], step[2]); term.pump(0.2)
            os.kill(term.pid, signal.SIGCONT); term.pump(0.5)
        elif op == 'check':
            term.pump(0.3)
            emulator.send({'k': 'snap', 'label': step[1]}); checks.append((step[1], step[2], step[3]))
    for _ in range(2): term.send('\x03'); term.pump(0.4)
    try: os.kill(term.pid, signal.SIGKILL); os.waitpid(term.pid, 0)
    except (ProcessLookupError, ChildProcessError): pass
    emulator.send({'k': 'end'})
    end = time.time() + 20
    while emulator.snaps is None and time.time() < end:
        select.select([emulator.out], [], [], 0.1)
        for event in emulator.events():
            if event['k'] == 'snaps': emulator.snaps = event['snaps']
    emulator.proc.wait(timeout=10)
    snaps_path = os.path.join(root, 'snaps.json')
    json.dump(emulator.snaps, open(snaps_path, 'w'))
    return root, snaps_path, checks

def run_tmux(name, spec, mode, keep):
    root = tempfile.mkdtemp(prefix=f'resize-matrix-{name}-')
    env, node = child_env(root, mode, spec['turns'], spec.get('env', {}))
    if spec.get('seed'): seed_conversations(root, spec['seed'], env, node)
    sock = f'rm-{os.getpid()}'
    tm = lambda *a: subprocess.run(['tmux', '-L', sock, *a], capture_output=True, text=True)
    conf = os.path.join(root, 'tmux.conf'); open(conf, 'w').write('set -g history-limit 100000\nset -g status off\n')
    envargs = [f'{k}={v}' for k, v in env.items()]
    cols, rows = spec['size']
    subprocess.run(['tmux', '-L', sock, '-f', conf, 'new-session', '-d', '-x', str(cols), '-y', str(rows), '-c', os.path.join(root, 'work'),
                    'env', '-i', *envargs, 'TERM=screen-256color', node, ENTRY], check=True)
    def screen():
        return tm('capture-pane', '-p', '-S', '-').stdout
    def wait(text, seconds):
        end = time.time() + seconds
        while time.time() < end:
            if text in screen(): return True
            time.sleep(0.2)
        return False
    snaps, checks = [], []
    time.sleep(4)
    for step in spec['steps']:
        op = step[0]
        if op == 'type': tm('send-keys', '-l', step[1]); time.sleep(0.2); tm('send-keys', 'Enter'); time.sleep(0.3)
        elif op == 'rapid':
            for _ in range(step[1]): tm('send-keys', '-l', step[2]); time.sleep(0.1); tm('send-keys', 'Enter'); time.sleep(0.9)
        elif op == 'keys': tm('send-keys', '-l', step[1]); time.sleep(0.3)
        elif op == 'wait': wait(step[1], step[2])
        elif op == 'settle': time.sleep(step[1])
        elif op == 'resize': tm('resize-window', '-x', str(step[1]), '-y', str(step[2])); time.sleep(0.05)
        elif op == 'burst':
            for c, r in step[1]: tm('resize-window', '-x', str(c), '-y', str(r)); time.sleep(step[2])
        elif op == 'suspend': tm('resize-window', '-x', str(step[1]), '-y', str(step[2])); time.sleep(0.5)  # tmux has no job control to drive here
        elif op == 'check':
            time.sleep(0.3)
            info = tm('display-message', '-p', '#{history_size} #{pane_width} #{pane_height} #{cursor_x} #{cursor_y} #{alternate_on}').stdout.split()
            hist, w, h, cx, cy, alt = int(info[0]), int(info[1]), int(info[2]), int(info[3]), int(info[4]), info[5] == '1'
            allrows = tm('capture-pane', '-p', '-S', '-').stdout.split('\n')
            if allrows and allrows[-1] == '': allrows.pop()
            allrows += [''] * (hist + h - len(allrows))
            rowobj = lambda t: {'text': t.rstrip(), 'wrapped': False}
            snaps.append({'label': step[1], 'cols': w, 'rows': h, 'alt': alt, 'scrollback': [rowobj(t) for t in allrows[:hist]],
                          'screen': [rowobj(t) for t in allrows[hist:hist + h]], 'cursor': {'x': cx, 'y': cy}})
            checks.append((step[1], step[2], step[3]))
    tm('kill-server')
    snaps_path = os.path.join(root, 'snaps.json'); json.dump(snaps, open(snaps_path, 'w'))
    return root, snaps_path, checks

def judge(snaps_path, checks, mode, emulator):
    snaps = json.load(open(snaps_path))
    for snap, (label, opts, markers) in zip(snaps, checks): snap['opts'] = opts; snap['expectMarkers'] = markers; snap['pulls'] = emulator == 'tmux'; snap['mute'] = emulator == 'xterm-mute'
    json.dump(snaps, open(snaps_path, 'w'))
    out = subprocess.run(['node', os.path.join(HERE, 'check.mjs'), snaps_path, mode], capture_output=True, text=True, cwd=REPO)
    if out.returncode: print(out.stderr); raise SystemExit(2)
    return json.loads(out.stdout), snaps

def show(snap):
    print(f"    --- {snap['label']} ({snap['cols']}x{snap['rows']}, alt={snap['alt']}, scrollback {len(snap['scrollback'])} rows, cursor {snap['cursor']['x'] + 1},{snap['cursor']['y'] + 1})")
    for row in snap['scrollback'][-3:]: print('    sb |' + row['text'][:snap['cols']])
    for index, row in enumerate(snap['screen']): print(f'    {index + 1:02d} |' + row['text'][:snap['cols']])

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--only'); parser.add_argument('--emu', default='xterm'); parser.add_argument('--mode', default='inline')
    parser.add_argument('--keep', action='store_true'); parser.add_argument('--show', action='store_true', help='print the screen of every failing snapshot')
    args = parser.parse_args()
    failures = 0; total = 0
    for name, spec in SCENARIOS.items():
        if args.only and args.only != name: continue
        if args.emu == 'tmux': root, snaps_path, checks = run_tmux(name, spec, args.mode, args.keep)
        else: root, snaps_path, checks = run_xterm(name, spec, args.mode, args.emu, args.keep)
        verdicts, snaps = judge(snaps_path, checks, 'full' if args.mode == 'full' else 'inline', args.emu)
        bad = [v for v in verdicts if v['problems']]
        total += len(verdicts); failures += len(bad)
        print(f"{'FAIL' if bad else 'ok  '} {name} [{args.emu}/{args.mode}] {len(verdicts) - len(bad)}/{len(verdicts)} snapshots ({root})")
        for verdict, snap in zip(verdicts, snaps):
            pass
            if snap.get('opts', {}).get('measure') and 'bytes' in snap: print(f"    {verdict['label']}: {snap['bytes']} bytes, {snap['historyRows']} history rows written")
            for problem in verdict['problems']: print(f"  - {verdict['label']} {verdict['size']}: {problem}")
            if verdict['problems'] and args.show: show(snap)
        if not args.keep and not bad: shutil.rmtree(root, ignore_errors=True)
    print(f'{failures} of {total} snapshots violate an invariant')
    sys.exit(1 if failures else 0)

if __name__ == '__main__': main()
