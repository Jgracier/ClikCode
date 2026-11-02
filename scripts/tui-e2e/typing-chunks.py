"""Typing-chunks check: the real TUI in a pty, bytes fed in the chunkings a phone keyboard produces, and the composer asserted equal to what was meant.

    uv run --quiet --with pyte scripts/tui-e2e/typing-chunks.py [--busy] [--gap-ms N] [dist/index.js]
"""
import argparse, fcntl, json, os, pty, re, select, shutil, struct, sys, tempfile, termios, time
import pyte

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
COLS, ROWS = 120, 40
TEXT = 'keyboard and the arrows is too sensitive and often twice at the same time'

def chunkings(text):
    words = text.split(' ')
    yield 'byte-at-a-time', [c for c in text]
    yield 'word | space', [p for w in words for p in (w, ' ')][:-1]
    yield 'word+space', [w + ' ' for w in words[:-1]] + [words[-1]]
    yield 'space+word', [words[0]] + [' ' + w for w in words[1:]]
    yield 'DEL-replace last letter (word, then DEL+letter+space)', [p for w in words[:-1] for p in (w, '\x7f' + w[-1] + ' ')] + [words[-1]]
    yield 'DEL-replace whole word (word, DEL*len + word + space)', [p for w in words[:-1] for p in (w, '\x7f' * len(w) + w + ' ')] + [words[-1]]
    yield 'two words per chunk', [' '.join(words[i:i + 2]) + (' ' if i + 2 < len(words) else '') for i in range(0, len(words), 2)]
    yield 'one chunk', [text]
    yield 'kitty-u space', [p for w in words for p in (w, '\x1b[32u')][:-1]

def launch(entry, busy, long_blocks=0):
    root = tempfile.mkdtemp(prefix='clikcode-typing-')
    home, state, fakebin, work = (os.path.join(root, p) for p in ('home', 'state', 'bin', 'work'))
    for p in (home, state, fakebin, work): os.makedirs(p)
    shutil.copy(os.path.join(REPO, 'scripts/tui-e2e/fake-grok.mjs'), os.path.join(fakebin, 'grok'))
    os.chmod(os.path.join(fakebin, 'grok'), 0o755)
    node = os.path.realpath(shutil.which('node'))
    nb = os.path.join(root, 'node-bin'); os.makedirs(nb)
    os.symlink(node, os.path.join(nb, 'node'))
    os.symlink(os.path.join(REPO, 'scripts/tui-e2e/fake-tailscale.mjs'), os.path.join(fakebin, 'tailscale'))
    turns = [{'intro': 'Starting the long build.', 'hold_ms': int(os.environ.get('HOLD', 600000)), 'blocks': ['done']}] if busy else [{'blocks': ['ok']}]
    if os.environ.get('STREAM') and busy:
        turns = [{'blocks': ['Streaming paragraph %d with `code`, **bold** text and a few more words to wrap across the row.' % i for i in range(900)]}]
    if long_blocks:
        para = 'Paragraph %d of the long answer: `code` and **bold** words, a list below.\n\n- first item here\n- second item here\n\n```ts\nconst value = compute(%d);\n```'
        turns = [{'blocks': [para % (i, i) for i in range(long_blocks)]}] + turns
    env = {'PATH': ':'.join([fakebin, nb, '/usr/bin', '/bin']), 'HOME': home, 'CLIKCODE_HOME': state, 'TERM': 'xterm-256color', 'LANG': 'C.UTF-8',
           'FAKE_TURNS': json.dumps(turns), 'FAKE_STATE': os.path.join(root, 'turn-counter'), 'FAKE_FAMILY': 'claude', 'FAKE_LOG': os.path.join(root, 'argv.log'),
           'FAKE_STEERING': '1', **({'FAKE_DELAY_MS': '15'} if os.environ.get('STREAM') else {}), 'SSH_CONNECTION': '127.0.0.1 1 127.0.0.1 22'}
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(work); os.execve(node, ['node', entry], env)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', ROWS, COLS, 0, 0))
    return pid, fd

class Term:
    def __init__(self, fd):
        self.fd = fd; self.screen = pyte.Screen(COLS, ROWS); self.stream = pyte.ByteStream(self.screen)
    def pump(self, seconds):
        end = time.time() + seconds
        while time.time() < end:
            r, _, _ = select.select([self.fd], [], [], 0.02)
            if r:
                try: chunk = os.read(self.fd, 65536)
                except OSError: return
                self.stream.feed(chunk)
    def text(self): return '\n'.join(self.screen.display)
    def composer(self):
        rows = [l.rstrip() for l in self.screen.display]
        marks = [i for i, l in enumerate(rows) if l.lstrip().startswith('›')]
        if os.environ.get('DUMP'): print('\n'.join(rows[-8:]))
        return rows[marks[-1]].lstrip()[1:].strip() if marks else None

def latency(entry, a):
    import statistics
    pid, fd = launch(entry, a.busy, a.latency)
    t = Term(fd); t.pump(4)
    for c in 'seed the transcript': os.write(fd, c.encode()); t.pump(0.02)
    os.write(fd, b'\r')
    for _ in range(120):
        t.pump(0.5)
        if 'Paragraph %d of' % (a.latency - 1) in t.text(): break
    t.pump(2)
    if a.busy:
        for c in 'start the build': os.write(fd, c.encode()); t.pump(0.02)
        os.write(fd, b'\r'); t.pump(2)
    samples = []
    for i, ch in enumerate('abcdefghijklmnopqrstuvwxyz' * 3):
        t.pump(0.15)
        t0 = time.perf_counter(); os.write(fd, ch.encode())
        seen = None
        while time.perf_counter() - t0 < 2:
            r, _, _ = select.select([fd], [], [], 0.002)
            if r:
                chunk = os.read(fd, 65536); t.stream.feed(chunk)
                if seen is None and ch.encode() in chunk and b'\x1b[' in chunk: seen = time.perf_counter() - t0; size = len(chunk); break
        samples.append((seen or 2.0) * 1000)
    s = sorted(samples)
    print(f"{'busy' if a.busy else 'idle'} transcript={a.latency} blocks: key->echo ms p50={s[len(s)//2]:.1f} p95={s[int(len(s)*0.95)]:.1f} max={s[-1]:.1f} n={len(s)} firstchunk={size}B")
    os.kill(pid, 9)

def handover(entry, a):
    # Typing that spans the end of the turn: the keys that land while the waiting composer gives way to the prompt.
    bad = 0
    for gap in (0.0, 0.01, 0.03, 0.06):
        for trial in range(2):
            pid, fd = launch(entry, True)
            os.environ['X'] = ''
            t = Term(fd); t.pump(4)
            for c in 'start the build': os.write(fd, c.encode()); t.pump(0.02)
            os.write(fd, b'\r'); t.pump(1.0)
            # the fake holds for 600 s; end it by killing nothing: use the stop key instead (Ctrl+C ends the turn, which hands the keyboard to the prompt)
            if not os.environ.get('HOLD'): os.write(fd, b'\x03')
            for ch in TEXT:
                os.write(fd, ch.encode()); t.pump(gap)
            t.pump(1.5)
            got = t.composer()
            ok = got == TEXT
            bad += not ok
            print(('PASS ' if ok else 'FAIL ') + f'handover gap={gap*1000:.0f}ms trial={trial}' + ('' if ok else f'\n   got  {got!r}'))
            try: os.kill(pid, 9); os.waitpid(pid, 0)
            except OSError: pass
    sys.exit(1 if bad else 0)

def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--busy', action='store_true'); ap.add_argument('--handover', action='store_true'); ap.add_argument('--gap-ms', type=float, default=5); ap.add_argument('--latency', type=int, default=0, help='blocks of seeded transcript; measures key to first echo instead of checking chunkings'); ap.add_argument('entry', nargs='?')
    a = ap.parse_args()
    entry = a.entry or os.path.join(REPO, 'dist/index.js')
    if a.latency: return latency(entry, a)
    if a.handover: return handover(entry, a)
    bad = 0
    for name, chunks in chunkings(TEXT):
        pid, fd = launch(entry, a.busy)
        t = Term(fd); t.pump(4)
        if a.busy:
            for c in 'start the build': os.write(fd, c.encode()); t.pump(0.02)
            os.write(fd, b'\r'); t.pump(0.5)
            for _ in range(40):
                if 'Starting the long build' in t.text() or 'sleep' in t.text(): break
                t.pump(0.5)
        for c in chunks:
            os.write(fd, c.encode()); t.pump(a.gap_ms / 1000)
        t.pump(0.8)
        got = t.composer()
        ok = got == TEXT
        bad += not ok
        print(('PASS ' if ok else 'FAIL ') + name + ('' if ok else f'\n   got  {got!r}\n   want {TEXT!r}'))
        if not ok and os.environ.get('DUMP'): print(t.text())
        try: os.kill(pid, 9); os.waitpid(pid, 0)
        except OSError: pass
    sys.exit(1 if bad else 0)

main()
