"""End-to-end display checks for the ClikCode TUI, against a fake vendor CLI.

Each scenario runs the real TUI in a pty with isolated state -- its own HOME,
CLIKCODE_HOME, and a PATH holding only the fake harness, node and system
tools, so no real vendor CLI can be selected and no account is touched --
drives it with keystrokes, and snapshots the emulated screen after every
chunk of output. Then it checks what matters for display fragility:

  * once a watched piece of text is on screen it never disappears;
  * at the end every watched piece is on screen exactly once;
  * consecutive blocks never run together without a paragraph break;
  * no non-trivial row of the transcript is on screen twice -- in the final
    screen or, for a stretch of frames, on the way (`dup_ok` lists the rows a
    scenario legitimately repeats; `no_dup_check` turns it off, with a reason).

A scenario may carry `expect_fail: '<stream>'`: it is an acceptance test for a
change that has not landed on this branch. It then reports XFAIL when it fails
(not counted as a failure) and XPASS when it passes (counted, so the mark is
removed). `--expect-fail` lists them and exits. See README.md.

    uv run --with pyte scripts/tui-e2e/run.py [--repeat N] [--only NAME] [dist/index.js]

Exit status 0 when every scenario passes every repeat. Captures of failures
are kept (the path is printed) so they can be replayed frame by frame.
"""
import os
import argparse, fcntl, hashlib, json, os, pty, re, select, shutil, signal, struct, sys, tempfile, termios, time

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


# --- Shared by the global duplicate check and the order checks --------------
RULE_ROW = re.compile(r'^\s*\u2500{20,}\s*$')
SPINNER_ROW = re.compile(r'^\s*[\u2800-\u28ff]{2}\s')
STATUS_ROW = re.compile(r'^\s*(?:[\u2800-\u28ff]{2}\s{2}\S|\u25cf\s)')
MIN_DUP_ROW = 12


def transcript_rows(text):
    """The rows above the composer's upper rule: the transcript and its live
    region. None when the screen has no composer (a board, a picker)."""
    lines = [line.rstrip() for line in text.split('\n')]
    rules = [i for i, line in enumerate(lines) if RULE_ROW.match(line)]
    return lines[:rules[-2]] if len(rules) >= 2 else None


def checkable_row(row):
    """A row that is content, not furniture: long enough to be a sentence,
    not a spinner/status band, not a turn's closing line, and with letters."""
    text = row.strip()
    if len(text) < MIN_DUP_ROW or SPINNER_ROW.match(row): return False
    if text.startswith('\u2500 ') and text.endswith(' \u2500'): return False  # `- Worked for 3s -`
    if text.startswith('signed in to') or text.startswith('Press Ctrl+C'): return False
    return sum(ch.isalnum() for ch in text) >= 6


def doubled_rows(text, allowed):
    """{row: count} of rows that appear more often than `allowed(row)` says."""
    rows = transcript_rows(text)
    if rows is None: return {}
    counts = {}
    for row in rows:
        if checkable_row(row): counts[re.sub(r'\s+', ' ', row.strip())] = counts.get(re.sub(r'\s+', ' ', row.strip()), 0) + 1
    return {row: n for row, n in counts.items() if n > allowed(row)}


def first_row(rows, phrase):
    return next((i for i, row in enumerate(rows) if phrase in row), None)


def table_misaligned(text):
    """Table rows (`|` and `+` box rows) whose column borders do not line up
    with the rows of the same table: a retired row drawn when the table was
    narrower. Returns the first offending row, or None."""
    group = []
    for line in text.split('\n') + ['']:
        line = line.rstrip()
        if line.strip().startswith(('\u2502', '\u251c')):
            group.append(line.strip())
            continue
        if len(group) > 1:
            marks = lambda row: [i for i, ch in enumerate(row) if ch in '\u2502\u253c\u251c\u2524']
            for row in group[1:]:
                if marks(row) != marks(group[0]): return row
        group = []
    return None


def gateway_fake(mode_env=None):
    """`setup` for a scenario that runs ClikCode's OWN agent through the fake
    Gateway (fake-gateway.mjs): a loopback OpenAI-compatible server, reached
    through the same configuration the real route reads (CLIKCODE_GATEWAY_URL
    and the canonical auth file, src/gateway/credentials.ts) inside the
    scenario's own HOME. The key is a placeholder that only this fake accepts."""
    def setup(context):
        import subprocess
        port_file = os.path.join(context['root'], 'gateway-port')
        log_file = os.path.join(context['root'], 'gateway.jsonl')
        server = subprocess.Popen(['node', os.path.join(REPO, 'scripts', 'tui-e2e', 'fake-gateway.mjs'), port_file],
                                  stdout=subprocess.DEVNULL, env={**os.environ, 'GATEWAY_FAKE_LOG': log_file, **(mode_env or {})})
        context['servers'] = [server]
        for _ in range(100):
            if os.path.exists(port_file) and open(port_file).read().strip(): break
            time.sleep(0.05)
        url = f"http://127.0.0.1:{open(port_file).read().strip()}"
        for name in ('alpha.txt', 'beta.txt'): open(os.path.join(context['workspace'], name), 'w').write(f'contents of {name}\n')
        auth_dir = os.path.join(context['home'], '.config', 'clikcode')
        os.makedirs(auth_dir, exist_ok=True)
        json.dump({'apiUrl': url, 'apiKey': 'fake-gateway-key', 'updatedAt': '2026-01-01T00:00:00.000Z'}, open(os.path.join(auth_dir, 'auth.json'), 'w'))
        context['env'].update({'CLIKCODE_GATEWAY_URL': url, 'XDG_CONFIG_HOME': os.path.join(context['home'], '.config'), 'GATEWAY_FAKE_LOG': log_file, **(mode_env or {})})
        context['stop_servers'] = lambda: [server.kill() for server in context['servers']]
        GATEWAY_STOPS.append(context['stop_servers'])
    return setup


GATEWAY_STOPS = []

TWO_BLOCKS = {'blocks': ['Checking the workspace first.', 'The final commit is live.']}

# Each step: ('type', text) types and presses Enter; ('wait_for', text, secs)
# waits until text is on screen; ('settle', secs) lets the screen quiet down.
# A second window on the same state: ('open2', secs, [args]) opens it, and 'type2',
# 'keys2', 'wait_for2', 'snap2', 'mark2' act on it as their plain forms do
# on the first; ('kill_workers', 'KILL') signals every conversation worker,
# ('expect_workers', n) waits for exactly n to be running. Checks on it:
# 'final2_contains', 'final2_once', 'never2' (from 'mark2' on); on any snap:
# 'snap_lacks', 'snap_once'.

def signed_in_fake(binary, auth_path, auth_text):
    """The one fake vendor, installed as `binary`, with the sign-in file its harness checks (catalog `authFiles`)."""
    def setup(context):
        target = os.path.join(context['fakebin'], binary)
        shutil.copy(os.path.join(REPO, 'scripts', 'tui-e2e', 'fake-grok.mjs'), target)
        os.chmod(target, 0o755)
        path = os.path.join(context['home'], auth_path)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        open(path, 'w').write(auth_text)
    return setup


def remote_installed(updates, pnpm_delay=0, current=False):
    """`setup` for ClikCode Remote keeping a machine current: the fakes of
    remote_fake, a repository whose main has moved on, and `devbox` already
    added (its record in this machine's machines.json, policy `updates`) and
    installed at the OLDER commit. This build stands for main's newer commit
    (CLIKCODE_REMOTE_LOCAL_COMMIT): the fake repository cannot hold this
    checkout's own. `/update` in a devbox chat runs this checkout's real
    ClikCode there (fake-remote-clikcode.mjs). `current`: this build stands
    for the installed commit instead, so the machine is up to date. No real
    machine or network."""
    def setup(context):
        import subprocess, datetime, uuid
        fakes = os.path.join(REPO, 'scripts', 'tui-e2e')
        shutil.copy(os.path.join(fakes, 'fake-grok.mjs'), os.path.join(context['fakebin'], 'grok'))
        os.chmod(os.path.join(context['fakebin'], 'grok'), 0o755)
        for name, script in (('ssh', 'fake-ssh.mjs'), ('tailscale', 'fake-tailscale.mjs')):
            os.symlink(os.path.join(fakes, script), os.path.join(context['fakebin'], name))
        world_root = os.path.join(context['root'], 'remote')
        os.makedirs(world_root)
        tool = lambda *args: json.loads(subprocess.check_output(['node', os.path.join(fakes, 'fake-remote.mjs'), *args]))
        made = tool('world', world_root, json.dumps({'second': True}))
        now = datetime.datetime.now(datetime.timezone.utc)
        iso = lambda minutes: (now - datetime.timedelta(minutes=minutes)).strftime('%Y-%m-%dT%H:%M:%S.000Z')
        chat = lambda id, title, minutes, preview: {'id': id, 'title': title, 'updatedAt': iso(minutes), 'messages': 4, 'preview': preview, 'section': 'active', 'current': False}
        target = 'devbox.tail-fake.ts.net'
        tool('host', world_root, target, json.dumps({
            'chats': [chat('c1', 'Fix the login page', 5, 'the button does nothing'), chat('c2', 'Write the migration tests', 30, 'cover the rollback')],
            'env': {'CLIKCODE_REMOTE_REPO_URL': made['repoUrl'], 'FAKE_CLIKCODE_CLI': os.path.abspath(os.path.join(os.path.dirname(context['entry']), 'cli.js')),
                    **({'FAKE_PNPM_DELAY': str(pnpm_delay)} if pnpm_delay else {})},
        }))
        tool('install', world_root, target, json.dumps({'repoUrl': made['repoUrl'], 'commit': made['first']}))
        os.makedirs(os.path.join(context['state'], 'remote'))
        record = {'id': str(uuid.uuid4()), 'name': 'devbox', 'sshTarget': target, 'addedAt': iso(60), 'ready': True,
                  'installed': {'version': '1.0.0', 'commit': made['first'], 'at': iso(60)}, 'updates': updates}
        with open(os.path.join(context['state'], 'remote', 'machines.json'), 'w') as handle:
            json.dump({'version': 1, 'machines': [record]}, handle)
        context['env'].update({
            'FAKE_SSH_ROOT': world_root, 'CLIKCODE_REMOTE_REPO_URL': made['repoUrl'], 'CLIKCODE_REMOTE_NODE_MIRROR': made['mirrorUrl'],
            'CLIKCODE_REMOTE_MACPORTS_MIRROR': made['macportsMirror'], 'CLIKCODE_REMOTE_MACPORTS_PINS': json.dumps(made['macportsPins']),
            'CLIKCODE_REMOTE_LOCAL_COMMIT': made['first'] if current else made['commit'],
        })
        context['remote'] = {'first': made['first'], 'commit': made['commit']}
    return setup


def remote_fake(commit=None, host_options=None):
    """`setup` for ClikCode Remote: a FAKE `ssh` and `tailscale` in fakebin
    (fake-ssh.mjs, fake-tailscale.mjs), a fake repository and Node mirror
    standing in for GitHub and nodejs.org, and one fake machine,
    `devbox.tail-fake.ts.net`, whose ClikCode lists two chats and, a few
    seconds after the board starts watching, updates one of them in place.
    No real machine, network or vendor CLI is involved (fake-remote.mjs)."""
    def setup(context):
        import subprocess, datetime
        fakes = os.path.join(REPO, 'scripts', 'tui-e2e')
        shutil.copy(os.path.join(fakes, 'fake-grok.mjs'), os.path.join(context['fakebin'], 'grok'))
        os.chmod(os.path.join(context['fakebin'], 'grok'), 0o755)
        for name, script in (('ssh', 'fake-ssh.mjs'), ('tailscale', 'fake-tailscale.mjs')):
            os.symlink(os.path.join(fakes, script), os.path.join(context['fakebin'], name))
        world_root = os.path.join(context['root'], 'remote')
        os.makedirs(world_root)
        tool = lambda *args: json.loads(subprocess.check_output(['node', os.path.join(fakes, 'fake-remote.mjs'), *args], env={**os.environ, 'PATH': os.environ['PATH']}))
        made = tool('world', world_root)
        # The remote runs this build's commit, so it does not read "needs update" -- unless `commit` says another.
        cli = open(os.path.join(os.path.dirname(context['entry']), 'cli.js')).read()
        found = re.search(r'CLIKCODE_COMMIT = "([0-9a-f]{40})"', cli)
        now = datetime.datetime.now(datetime.timezone.utc)
        iso = lambda minutes: (now - datetime.timedelta(minutes=minutes)).strftime('%Y-%m-%dT%H:%M:%S.000Z')
        chat = lambda id, title, minutes, preview: {'id': id, 'title': title, 'updatedAt': iso(minutes), 'messages': 4, 'preview': preview, 'section': 'active', 'current': False}
        # c1 was saved in a folder of THIS (the client's) machine, as an editor once made one:
        # the machine that owns it does not have it (fake-ssh.mjs FAKE_MACHINE) and says so.
        stale = {**chat('c1', 'Fix the login page', 5, 'the button does nothing'), 'workspace': context['home']}
        tool('host', world_root, 'devbox.tail-fake.ts.net', json.dumps({
            'chats': [stale, chat('c2', 'Write the migration tests', 30, 'cover the rollback')],
            'later': {'afterMs': 6000, 'chats': [{**chat('c1', 'Fix the login page', 0, 'now it submits twice'), 'workspace': context['home']}, chat('c2', 'Write the migration tests', 30, 'cover the rollback')]},
            **({'commit': commit} if commit else {'commit': found.group(1)} if found else {}),
            **(host_options or {}),
        }))
        status = os.path.join(world_root, 'tailscale.json')
        open(status, 'w').write(subprocess.check_output(['node', os.path.join(fakes, 'fake-remote.mjs'), 'tailscale']).decode())
        context['env'].update({
            'FAKE_SSH_ROOT': world_root, 'FAKE_TAILSCALE_STATUS': status,
            'CLIKCODE_REMOTE_REPO_URL': made['repoUrl'], 'CLIKCODE_REMOTE_NODE_MIRROR': made['mirrorUrl'],
            'CLIKCODE_REMOTE_MACPORTS_MIRROR': made['macportsMirror'], 'CLIKCODE_REMOTE_MACPORTS_PINS': json.dumps(made['macportsPins']),
        })
    return setup


def remote_move(latency_ms=0, count_bytes=False, remote_signed_in=True, remote_env=None):
    """`setup` for moving a chat to another machine (/machine): the fake `ssh`
    (fake-ssh.mjs) and one fake machine, `devbox`, already added, running THIS
    build's real ClikCode (its bridge, its worker, its turns) in a HOME, user
    and state of its own, with the fake Grok there signed in. Grok is signed
    in here too. The fake Grok there logs every prompt to remote-prompts.log,
    so a step can count what the agent there was told. `latency_ms`: what
    devbox sends back arrives that late (a slow link); `count_bytes`: every
    byte it sends back is counted (fake-ssh.mjs, for 'bytes_mark').
    `remote_signed_in=False`: Grok is installed on devbox but nobody has signed
    in to it there (its fake login prints a device link and finishes after 2 s).
    No real machine or vendor."""
    def setup(context):
        import subprocess, datetime, uuid
        fakes = os.path.join(REPO, 'scripts', 'tui-e2e')
        shutil.copy(os.path.join(fakes, 'fake-grok.mjs'), os.path.join(context['fakebin'], 'grok'))
        os.chmod(os.path.join(context['fakebin'], 'grok'), 0o755)
        os.symlink(os.path.join(fakes, 'fake-ssh.mjs'), os.path.join(context['fakebin'], 'ssh'))
        os.makedirs(os.path.join(context['home'], '.grok'))
        open(os.path.join(context['home'], '.grok', 'auth.json'), 'w').write('{}')
        world_root = os.path.join(context['root'], 'remote')
        os.makedirs(world_root)
        # A short name: the worker's socket there is in its TMPDIR, inside this scenario's
        # temporary root, and a Unix socket path has to fit in 108 bytes.
        target = 'devbox'
        made = json.loads(subprocess.check_output(['node', os.path.join(fakes, 'fake-remote.mjs'), 'host', world_root, target, json.dumps({'env': {
            'FAKE_TURNS': json.dumps([{'blocks': ['Answered on devbox.']}, {'blocks': ['Second answer on devbox.']}, {'blocks': ['Third answer on devbox.']}]),
            'FAKE_STATE': os.path.join(context['root'], 'remote-turn-counter'), 'FAKE_PROMPT_LOG': os.path.join(context['root'], 'remote-prompts.log'),
            'FAKE_FAMILY': 'claude', **(remote_env or {}),
        }, **({'latencyMs': latency_ms} if latency_ms else {}), **({'countBytes': True} if count_bytes else {})})]))
        remote_home, remote_bin = made['home'], made['bin']
        shutil.copy(os.path.join(fakes, 'fake-grok.mjs'), os.path.join(remote_bin, 'grok'))
        os.chmod(os.path.join(remote_bin, 'grok'), 0o755)
        if remote_signed_in:
            os.makedirs(os.path.join(remote_home, '.grok'))
            open(os.path.join(remote_home, '.grok', 'auth.json'), 'w').write('{}')
        os.makedirs(os.path.join(remote_home, '.local', 'bin'))
        launcher = os.path.join(remote_home, '.local', 'bin', 'clikcode')
        open(launcher, 'w').write(f"#!/bin/sh\nexec {os.path.realpath(shutil.which('node'))} {os.path.abspath(context['entry'])} \"$@\"\n")
        os.chmod(launcher, 0o755)
        os.makedirs(os.path.join(context['state'], 'remote'))
        now = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z')
        record = {'id': str(uuid.uuid4()), 'name': 'devbox', 'sshTarget': target, 'addedAt': now, 'ready': True, 'updates': 'ask'}
        with open(os.path.join(context['state'], 'remote', 'machines.json'), 'w') as handle:
            json.dump({'version': 1, 'machines': [record]}, handle)
        context['env'].update({'FAKE_SSH_ROOT': world_root})
    return setup


SCENARIOS = {
    'two-blocks-with-tool': {
        'turns': [TWO_BLOCKS],
        'steps': [('type', 'please check the commit'), ('wait_for', 'The final commit is live.', 30), ('settle', 4)],
        'watch': ['please check the commit', 'Checking the workspace first.', 'The final commit is live.'],
        # A turn that ran a tool ends on one line saying so, written once.
        
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
    # A newer build lands while the window is on a draft -- a chat nothing
    # has happened in yet, which lives in this process only. The re-exec
    # reopens that draft, its setup with it; it used to find nothing on
    # disk and land on a fresh chat saying "no chat matches <id>".
    'rebuild-on-draft-reopens-it': {
        'rebuild_entry': True,
        'turns': [TWO_BLOCKS],
        'steps': [('type', '/model grok-4-fast'), ('wait_for', 'grok-4-fast', 10), ('settle', 2),
                  ('touch_entry',), ('settle', 20), ('mark',),
                  ('type', 'please check the commit'), ('wait_for', 'The final commit is live.', 30), ('settle', 2)],
        'watch': [], 'never': ['no chat matches'], 'final_contains': ['grok-4-fast', 'The final commit is live.'],
    },
    # The same for the draft /new opens after a conversation.
    'rebuild-after-new-reopens-draft': {
        'rebuild_entry': True,
        'turns': [TWO_BLOCKS, {'blocks': ['Second answer arrives here.']}],
        'steps': [('type', 'hello'), ('wait_for', 'The final commit is live.', 30), ('settle', 2), ('type', '/new'), ('settle', 3),
                  ('touch_entry',), ('settle', 20),
                  ('type', 'and the second question'), ('wait_for', 'Second answer arrives here.', 30), ('settle', 2)],
        'watch': [], 'never': ['no chat matches'],
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
    # A turn with a checklist: stepping out to the board mid-turn takes the
    # checklist with the turn. It used to stay drawn under the board, with no
    # turn, pushing the board's top rows -- Working, the chat just left -- off
    # the screen. Back in the chat, the checklist is there again.
    'board-leaves-turn-plan': {
        'turns': [{'blocks': ['First chat answered.']},
                  {'emits': [{'op': 'text', 'text': 'Working through the list.\n\n', 'ms': 5},
                             {'op': 'plan', 'entries': [{'content': f'PLANSTEP{n} item', 'status': 'completed' if n < 3 else 'in_progress' if n == 3 else 'pending'} for n in range(1, 9)]},
                             {'op': 'sleep', 'ms': 20000}, {'op': 'text', 'text': 'List finished.', 'ms': 5}]}],
        'steps': [
            ('type', 'hello'), ('wait_for', 'First chat answered.', 30), ('settle', 2),
            ('keys', '\x1b[D'), ('settle', 2), ('type', 'work the list'), ('wait_for', 'PLANSTEP3 item', 30), ('settle', 2),
            ('keys', '\x1b[D'), ('settle', 3), ('snap', 'board'),
            ('keys', '\x1b[C'), ('settle', 3), ('snap', 'back'),
            ('wait_for', 'List finished.', 40), ('settle', 2),
        ],
        'watch': ['List finished.'],
        'snap_contains': {'board': ['Working', 'Recent'], 'back': ['PLANSTEP3 item']},
        'snap_lacks': {'board': ['PLANSTEP']},
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
        'snap_contains': {'board1': ['Working', 'working', '2 agents', 'Recent', 'enter open · tab options · del delete · ← machines']},
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
    # found"): a fresh chat opens, silently, and the message waits in its
    # composer.
    'chat-deleted-in-other-window': {
        'turns': [{'blocks': ['DOOMED answer lives here.']}, {'blocks': ['Fresh chat answered.']}],
        'steps': [
            ('type', 'doomed question'), ('wait_for', 'DOOMED answer lives here.', 30), ('settle', 2),
            ('open2', 6, ['--continue']), ('wait_for2', 'DOOMED answer lives here.', 10),
            ('keys2', '\x1b[D'), ('settle', 2), ('keys2', '\x1b[3~'), ('wait_for2', 'Cancel', 10),
            ('keys2', '\x1b[B'), ('keys2', '\r'), ('settle', 3),
            ('mark',), ('type', 'are you there'), ('settle', 4), ('snap', 'kept'),
            ('keys', '\r'), ('wait_for', 'Fresh chat answered.', 30), ('settle', 2),
        ],
        'watch': [], 'final_contains': ['are you there', 'Fresh chat answered.'],
        'snap_contains': {'kept': ['› are you there']},
        'never_after_mark': ['not found', 'was deleted'],
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
    # Two windows on one chat, both attached to its worker. A message sent from one shows on the other WHILE its turn runs, not
    # after it ends (the held call keeps the turn open for 20 s: the prompt has to be there well before that).
    'prompt-shows-in-other-window': {
        'turns': [{'blocks': ['First chat answered.']}, {'intro': 'Starting the long build.', 'hold_ms': 20000, 'blocks': ['The build passed.']}],
        'steps': [
            ('type', 'hello'), ('wait_for', 'First chat answered.', 30), ('settle', 2),
            ('open2', 6, ['--continue']), ('wait_for2', 'First chat answered.', 10), ('settle', 2),
            ('type2', 'sent from window two'), ('wait_for', 'sent from window two', 8), ('snap', 'during'),
            ('wait_for', 'The build passed.', 40), ('settle', 2),
        ],
        'watch': [], 'final_contains': ['sent from window two', 'The build passed.'],
        'snap_contains': {'during': ['sent from window two']},
    },
    'prompt-shows-in-first-window': {
        'turns': [{'blocks': ['First chat answered.']}, {'intro': 'Starting the long build.', 'hold_ms': 20000, 'blocks': ['The build passed.']}],
        'steps': [
            ('type', 'hello'), ('wait_for', 'First chat answered.', 30), ('settle', 2),
            ('open2', 6, ['--continue']), ('wait_for2', 'First chat answered.', 10), ('settle', 2),
            ('type', 'sent from window one'), ('wait_for2', 'sent from window one', 8), ('snap2', 'during'),
            ('wait_for2', 'The build passed.', 40), ('settle', 2),
        ],
        'watch': [], 'final_contains': ['sent from window one', 'The build passed.'],
        'snap_contains': {'during': ['sent from window one']},
    },
    # The worker running a turn is killed mid-call. The turn ends there as a
    # stopped one, under its own prompt -- its answer used to be drawn above
    # it, the call left running (‣), and "session worker connection closed
    # unexpectedly" shown -- and the next message starts a worker again.
    'worker-killed-mid-turn': {
        'turns': [{'intro': 'Starting the long build.', 'hold_ms': 20000, 'blocks': ['The build passed.']},
                  {'blocks': ['Second answer arrives here.']}],
        'steps': [
            ('type', 'start the build'), ('wait_for', 'sleep 30', 30), ('settle', 2),
            ('kill_workers', 'KILL'), ('wait_for', 'sleep 30 stopped', 10), ('settle', 2), ('snap', 'stopped'),
            ('type', 'carry on'), ('wait_for', 'Second answer arrives here.', 30), ('settle', 2),
        ],
        'watch': [],
        # Its call settled as stopped. No closing line: the worker that would
        # have saved the turn's end is gone, and that line is the saved one.
        'snap_contains': {'stopped': ['sleep 30 stopped']},
        'snap_once': {'stopped': ['start the build', 'Starting the long build.']},
        'snap_lacks': {'stopped': ['‣', 'Worked for']},
        'final_once': ['Second answer arrives here.'], 'never': ['closed unexpectedly', 'send again to continue', "worker stopped"],
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
        'watch': [], 'snap_contains': {'one': ['› take this back']},
        'snap_lacks': {'one': ['draft restored'], 'two': ['› take this back', 'draft restored']},
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
            ('keys2', '\x1b'), ('wait_for2', 'Stopped', 10), ('settle', 3),
        ],
        'watch': [], 'final_once': ['Stopped'], 'final2_once': ['Stopped'],
        'never': ['Worked for'], 'never2': ['Worked for'],
    },
    # "Worked for" is the saved turn's, not only the window's that watched it
    # end: it is there after going to another chat and back, and after the
    # window is closed and opened again. It used to be drawn live only.
    'worked-for-survives-board-and-restart': {
        'turns': [TWO_BLOCKS, {'blocks': ['Other chat answered.']}],
        'steps': [
            ('type', 'please check the commit'), ('wait_for', 'The final commit is live.', 30), ('settle', 2),
            ('keys', '\x1b[D'), ('settle', 2), ('type', 'another chat'), ('wait_for', 'Other chat answered.', 30), ('settle', 2),
            ('keys', '\x1b[D'), ('settle', 2), ('keys', '\x1b[B'), ('settle', 0.5), ('keys', '\r'),
            ('wait_for', 'The final commit is live.', 10), ('settle', 2), ('snap', 'back'),
            ('restart',), ('keys', '\x1b[D'), ('settle', 2), ('keys', '\x1b[B'), ('settle', 0.5), ('keys', '\r'),
            ('wait_for', 'The final commit is live.', 10), ('settle', 2),
        ],
        'watch': [], 
        'final_contains': ['please check the commit'],
    },
    # Switching chats from the board is ONE change on screen: the board, then the
    # other conversation with its composer. Closing the board used to paint the
    # conversation being left (its last rows, no composer) into the freed space, and
    # the one chosen a moment later -- the composer vanishing and the chat hopping
    # before the new one loaded. Several switches, then Esc out of the board.
    'switch-chats-is-one-frame': {
        'turns': [TWO_BLOCKS, {'blocks': ['Other chat answered.']}],
        'steps': [
            ('type', 'please check the commit'), ('wait_for', 'The final commit is live.', 30), ('settle', 2),
            ('keys', '\x1b[D'), ('settle', 2), ('type', 'another chat'), ('wait_for', 'Other chat answered.', 30), ('settle', 2),
            ('keys', '\x1b[D'), ('settle', 2), ('keys', '\x1b[B'), ('settle', 0.5), ('keys', '\r'),
            ('wait_for', 'The final commit is live.', 10), ('settle', 2),
            # Back on the first chat the cursor starts on its row, below the newer one: Up for the other.
            ('keys', '\x1b[D'), ('settle', 2), ('keys', '\x1b[A'), ('settle', 0.5), ('keys', '\r'),
            ('wait_for', 'Other chat answered.', 10), ('settle', 2),
            ('keys', '\x1b[D'), ('settle', 2), ('keys', '\x1b'), ('settle', 2),
        ],
        'watch': [],
        'stable_handoff': True,
        'same_row': ['please check the commit'],
        'final_contains': ['another chat'],
    },
    # A chat taller than the screen, left for the board and another chat and opened again:
    # its lines are on the rows they were on, not drawn short and then moved.
    'switch-long-chats-keeps-rows': {
        'cols': 70, 'rows': 40,
        'turns': [{'emits': [{'op': 'text', 'text': f'run part{n} done.\n\n', 'ms': 5} for n in range(1, 31)]}, {'blocks': ['Other chat answered.']}],
        'steps': [
            ('type', 'run every part'), ('wait_for', 'run part30 done.', 30), ('settle', 2),
            ('keys', '\x1b[D'), ('settle', 2), ('type', 'another chat'), ('wait_for', 'Other chat answered.', 30), ('settle', 2),
            ('keys', '\x1b[D'), ('settle', 2), ('keys', '\x1b[B'), ('settle', 0.5), ('keys', '\r'),
            ('wait_for', 'run part30 done.', 10), ('settle', 2),
            ('keys', '\x1b[D'), ('settle', 2), ('keys', '\x1b[A'), ('settle', 0.5), ('keys', '\r'),
            ('wait_for', 'Other chat answered.', 10), ('settle', 2),
            ('keys', '\x1b[D'), ('settle', 2), ('keys', '\x1b[B'), ('settle', 0.5), ('keys', '\r'),
            ('wait_for', 'run part30 done.', 10), ('settle', 2),
        ],
        'watch': [],
        'stable_handoff': True,
        'same_row': ['run part30 done.', 'run part25 done.', 'run part20 done.'],
    },
    # Left and straight Right on the same chat: the chat comes back on the rows it was on.
    'board-quick-return-same-chat': {
        'cols': 70, 'rows': 40,
        'turns': [{'emits': [{'op': 'text', 'text': f'run part{n} done.\n\n', 'ms': 5} for n in range(1, 31)]}],
        'steps': [
            ('type', 'run every part'), ('wait_for', 'run part30 done.', 30), ('settle', 2), ('mark',),
            ('keys', '\x1b[D'), ('settle', 0.15), ('keys', '\x1b[C'), ('settle', 2),
            ('keys', '\x1b[D'), ('settle', 1), ('keys', '\x1b[C'), ('settle', 2),
            ('keys', '\x1b[D'), ('settle', 0.05), ('keys', '\x1b[C'), ('settle', 2), ('mark_end',),
        ],
        'watch': [],
        'same_row': ['run part30 done.', 'run part25 done.', 'run part20 done.'],
        'shown_outside_board': ['run part30 done.'],
    },
    # A working turn holds still (a long tool, or sub-agents) while the window goes to the board and
    # back: the history lines come back on the rows they were on, whatever the activity rows below are doing.
    'board-return-while-tool-holds': {
        'cols': 70, 'rows': 40, 'env': {'FAKE_TOOL_MS': '150', 'FAKE_DELAY_MS': '40'},
        'turns': [{'emits': [*[{'op': 'text', 'text': f'run part{n} done.\n\n', 'ms': 5} for n in range(1, 31)],
                             {'op': 'tool', 'id': 'hold', 'title': 'sleep 30', 'ms': 25000}]}],
        'steps': [
            ('type', 'run every part'), ('wait_for', 'sleep 30', 40), ('settle', 3),
            ('keys', '\x1b[D'), ('settle', 1.5), ('keys', '\x1b[C'), ('settle', 2.5),
            ('keys', '\x1b[D'), ('settle', 1.5), ('keys', '\x1b[C'), ('settle', 2.5),
        ],
        'watch': [],
        'same_row': ['run part30 done.', 'run part20 done.', 'sleep 30'],
        'timer_counts_up': [r'running sleep · (\d+)s'],
        'shown_outside_board': ['run part30 done.'],
    },
    'board-return-while-agents-hold': {
        'cols': 70, 'rows': 40,
        'turns': [{'intro': 'Starting the long build.', 'subagents': {'count': 2, 'calls': 40, 'hold_ms': 15000}, 'blocks': ['The build passed.']}],
        'steps': [
            ('type', 'start the build'), ('wait_for', 'Starting the long build.', 30), ('settle', 4),
            ('keys', '\x1b[D'), ('settle', 1.5), ('keys', '\x1b[C'), ('settle', 2.5),
            ('keys', '\x1b[D'), ('settle', 1.5), ('keys', '\x1b[C'), ('settle', 2.5),
        ],
        'watch': [],
        'same_row': ['Starting the long build.', 'start the build'],
        'timer_counts_up': [r'waiting on agent · (\d+)s', r'Agent worker 0 · \d+ tool uses · (\d+)s'],
        'shown_outside_board': ['Starting the long build.'],
    },
    'board-composer-empty-after-open': {
        'turns': [TWO_BLOCKS, {'blocks': ['Other chat answered.']}],
        'steps': [
            ('type', 'please check the commit'), ('wait_for', 'The final commit is live.', 30), ('settle', 2),
            ('type', '/rename Quiet River'), ('settle', 2), ('snap', 'named'),
            ('keys', '\x1b[D'), ('settle', 2), ('snap', 'board-first'), ('keys', '\x1b[C'), ('settle', 2), ('snap', 'chat'),
            ('keys', '\x1b[D'), ('settle', 2), ('snap', 'board-again'),
            ('keys', '\x1b[C'), ('settle', 2), ('keys', '\x1b[D'), ('settle', 2), ('snap', 'board-third'),
        ],
        'watch': [],
        # The chat's name is on its own composer's rule; the board's composer starts another chat and has none.
        'snap_contains': {'named': ['Quiet River'], 'chat': ['Quiet River'], 'board-first': ['Quiet River']},
        'snap_rules_lack': {'board-first': ['Quiet River'], 'board-again': ['Quiet River'], 'board-third': ['Quiet River']},
    },
    # The turn is over but the vendor still runs a terminal: the board keeps the chat under Working
    # while it does, and lists it as idle once the work is done.
    'board-working-while-background-runs': {
        'turns': [{'emits': [
            {'op': 'text', 'text': 'The dev server is started.'},
            {'op': 'background', 'tasks': [{'type': 'local_bash', 'description': 'npm run dev'}]}],
            'after': [{'op': 'sleep', 'ms': 14000}, {'op': 'background', 'tasks': []}]}],
        'steps': [('type', 'start the server'), ('wait_for', '1 background terminal running', 30), ('settle', 1),
                  ('keys', '\x1b[D'), ('settle', 2), ('snap', 'board-while'), ('keys', '\x1b'), ('settle', 1),
                  ('wait_for', 'The dev server is started.', 5), ('settle', 14),
                  ('keys', '\x1b[D'), ('settle', 2), ('snap', 'board-after')],
        'watch': [],
        'snap_contains': {'board-while': ['Working', 'working'], 'board-after': ['Recent']},
        'snap_lacks': {'board-after': ['Working']},
    },
    # A turn is working and the composer is empty: Right opens the command menu, as it does between turns.
    'right-arrow-opens-menu-mid-turn': {
        'cols': 90, 'env': {'FAKE_TOOL_MS': '150'},
        'turns': [{'emits': [{'op': 'text', 'text': 'Working on it.\n\n', 'ms': 5}, {'op': 'tool', 'id': 'hold', 'title': 'sleep 30', 'ms': 20000}]}],
        'steps': [('type', 'do the long thing'), ('wait_for', 'sleep 30', 40), ('settle', 1.5),
                  ('keys', '\x1b[C'), ('settle', 1.5), ('snap', 'menu'), ('keys', '\x7f'), ('settle', 1), ('snap', 'closed')],
        'watch': [],
        'snap_contains': {'menu': ['/model', '/sessions']},
        'snap_lacks': {'closed': ['/model']},
    },
    # Said with no turn open (a background agent finishing): the words stream onto the screen as
    # the vendor sends them, appear once, and are in the conversation after a restart.
    'out-of-turn-streams-live': {
        'turns': [{'blocks': ['The agent is running in the background.'],
                   'after': [{'op': 'sleep', 'ms': 1500},
                             {'op': 'say', 'ms': 400, 'text': 'Background agent finished: alpha bravo charlie delta echo foxtrot golf hotel india juliet.'}]}],
        'steps': [
            ('type', 'start the agent'), ('wait_for', 'The agent is running in the background.', 30),
            ('wait_for', 'alpha bravo', 15), ('snap', 'streaming'),
            ('wait_for', 'india juliet.', 15), ('settle', 3), ('snap', 'done'),
            ('restart',), ('keys', '\x1b[D'), ('settle', 2), ('keys', '\r'), ('wait_for', 'india juliet.', 15), ('settle', 1),
        ],
        'watch': [],
        'snap_lacks': {'streaming': ['india juliet.']},
        'final_once': ['Background agent finished: alpha bravo charlie delta echo foxtrot golf hotel india juliet.'],
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
    # ClikCode Remote (/remote): the list opens over a fixed footer, with the
    # tailnet's machines (fixture Tailscale: same owner, desktop OS, recent,
    # deduped); choosing one installs ClikCode there a named step at a time;
    # then the board shows that machine's section and its chats, which update
    # in place without moving. The composer stays on its row throughout.
    'remote-add-machine-to-board': {
        'setup': remote_fake(), 'startup': 4, 'no_dup_check': 'lists and progress lines, no transcript',
        'turns': [{'blocks': ['unused']}],
        'steps': [
            ('settle', 2), ('snap', 'closed'),
            ('type', '/machine'), ('wait_for', 'Move this chat to', 15), ('wait_for', 'macbook', 10), ('settle', 1), ('keys', '\x1b[B'), ('snap', 'list'),
            # Tailscale gives the machine, not the account on it: which user is asked first, typed, nothing suggested.
            ('keys', '\r'), ('wait_for', 'Log in to devbox as which user?', 15), ('settle', 0.5), ('snap', 'user'),
            ('type', 'bad user'), ('wait_for', 'is not a user name', 10), ('settle', 0.5), ('snap', 'user-invalid'),
            ('type', 'dev'), ('wait_for', 'devbox is added', 60), ('settle', 1), ('snap', 'installed'),
            # Left from the chat on devbox: devbox's chats; Left again: the machines, on devbox.
            ('keys', '\x1b[D'), ('wait_for', 'Fix the login page', 20), ('settle', 0.5), ('snap', 'board'),
            ('wait_for', 'now it submits twice', 20), ('settle', 0.5), ('snap', 'board-updated'),
            ('keys', '\x1b[D'), ('wait_for', 'Machines', 20), ('settle', 0.5), ('snap', 'machines'),
            ('keys', '\x1b[C'), ('wait_for', 'Fix the login page', 20), ('settle', 0.5),
            ('keys', '\x1b[B'), ('keys', '\x1b[C'), ('wait_for', 'The folder /', 10), ('snap', 'opened'),
            ('type', 'check the remote'), ('wait_for', 'Remote answer received.', 15), ('snap', 'answered'),
            ('type', '/provider'), ('wait_for', 'Choose a provider', 10), ('keys', '\x1b[B'), ('keys', '\r'),
            ('wait_for', 'Claude Code', 10), ('snap', 'provider-changed'),
            ('keys', '\x1b[D'), ('wait_for', 'Write the migration tests', 20), ('snap', 'back-to-chats'),
            ('keys', '\x1b[D'), ('wait_for', 'Machines', 10), ('snap', 'back-to-machines'),
        ],
        'watch': [],
        'snap_contains': {
            'list': ['Move this chat to', 'On your tailnet', 'devbox', 'imac', 'macbook', 'winbox  · windows · not supported yet', 'Add by SSH address'],
            'user': ['Log in to devbox as which user?'],
            'user-invalid': ['"bad user" is not a user name.', 'Log in to devbox as which user?'],
            # Added from /machine, the (empty) chat starts there.
            'installed': ['devbox  •'],
            'machines': ['Machines', '❯ devbox'],
            'board': ['Fix the login page', 'the button does nothing', 'Write the migration tests'],
            'board-updated': ['now it submits twice'],
            # Its scenario path is too long for the row; the words after it are cut.
            'opened': ['The folder /'],
            'answered': ['Remote answer received.'],
            'provider-changed': ['Claude Code', 'devbox'],
            'back-to-chats': ['Fix the login page', 'Write the migration tests'],
            'back-to-machines': ['Machines', 'devbox'],
        },
        'snap_lacks': {'list': ['studios-imac', 'old-server', 'iphone', 'gaming-pc', 'friends-laptop'], 'board': ['needs update'], 'board-updated': ['the button does nothing'],
                       'user': ["ssh's default", 'root', 'Another user…'],
                       'opened': ['another ClikCode build', 'ENOENT']},
        # The user question is asked on the composer's own line, so it is not compared.
        'snap_composer_same': ['list', 'installed', 'opened'],
        'snap_pair_same_row': [('board', 'board-updated', 'Fix the login page'), ('board', 'board-updated', 'Write the migration tests')],
        # Each step of the install is said in the chat as it happens.
        'ever': ['Installing ClikCode on devbox (dev@devbox.tail-fake.ts.net)', '1/6 Checking the machine', '2/6 Node.js', '3/6 git', '4/6 Getting ClikCode from GitHub', '5/6 Building and installing'],
        'never': ['Windows machines', 'ENOENT'],
    },
    # The machines Tailscale knows and that are not added are in every list of
    # machines, not only /remote: /machine's, and the board's Machines. Choosing
    # one on the board adds it -- which user first, then the install -- and the
    # board opens again on its chats.
    'board-add-tailnet-machine': {
        'setup': remote_fake(), 'startup': 4, 'no_dup_check': 'lists and progress lines, no transcript',
        'turns': [{'blocks': ['unused']}],
        'steps': [
            ('settle', 2),
            ('type', '/machine'), ('wait_for', 'Move this chat to', 15), ('wait_for', 'On your tailnet', 10), ('wait_for', 'macbook', 10), ('settle', 1), ('snap', 'machine'),
            ('keys', '\x1b'), ('settle', 1),
            ('keys', '\x1b[D'), ('wait_for', '← machines', 20), ('keys', '\x1b[D'), ('wait_for', 'On your tailnet', 20), ('settle', 1), ('snap', 'machines'),
            ('keys', '\x1b[B'), ('keys', '\r'), ('wait_for', 'Log in to devbox as which user?', 15), ('settle', 0.5), ('snap', 'user'),
            ('type', 'root'), ('wait_for', 'Fix the login page', 60), ('settle', 1), ('snap', 'board'),
            ('keys', '\x1b[D'), ('wait_for', 'Machines', 10), ('wait_for', 'devbox  · connected', 20), ('settle', 0.5), ('snap', 'added'),
        ],
        'watch': [],
        'snap_contains': {
            'machine': ['Move this chat to', 'On your tailnet', 'devbox', '· linux · add: install ClikCode', 'imac', 'macbook  · macOS · offline', 'winbox'],
            'machines': ['Machines', 'On your tailnet', 'devbox', 'add: install ClikCode', 'imac', 'macbook'],
            'user': ['Log in to devbox as which user?'],
            'board': ['Fix the login page', 'Write the migration tests'],
            'added': ['devbox  · connected'],
        },
        'snap_lacks': {'machine': ['studios-imac', 'old-server', 'iphone', 'gaming-pc', 'friends-laptop'], 'machines': ['studios-imac', 'friends-laptop'],
                       'added': ['devbox  · linux'], 'user': ['Another user…', "ssh's default"]},
        'never': ['ENOENT', 'Windows machines'],
    },
    # /machine: the chat's machine is one of its settings, and choosing another
    # moves the chat there -- its conversation, on devbox's own ClikCode -- and
    # the next message is answered there, by devbox's agent, told once (and
    # unseen) that the chat moved. Nothing changes, so nothing is asked.
    # There, `/` is devbox's slash menu (with /machine), and a command chosen
    # runs on devbox. The chat is then listed only under devbox: Left, Left,
    # this machine has no row for it; devbox's row opens it live, nothing moved.
    'machine-move-chat': {
        'setup': remote_move(), 'startup': 4, 'no_dup_check': 'the transcript is drawn again on the other machine',
        'turns': [{'blocks': ['First answer here.']}],
        'steps': [
            ('type', 'hello there'), ('wait_for', 'First answer here.', 30), ('settle', 1),
            # The board, twice, shows devbox over the window's one connection to it, kept after it closes.
            ('keys', '\x1b[D'), ('wait_for', '← machines', 20), ('keys', '\x1b[D'), ('wait_for', 'devbox  · connected', 20), ('keys', '\x1b'), ('settle', 1), ('keys', '\x1b'), ('settle', 1),
            ('keys', '\x1b[D'), ('wait_for', '← machines', 20), ('keys', '\x1b[D'), ('wait_for', 'devbox  · connected', 20), ('keys', '\x1b'), ('settle', 1), ('keys', '\x1b'), ('settle', 1),
            ('type', '/machine'), ('wait_for', 'Move this chat to', 20), ('wait_for', 'devbox', 10), ('settle', 1), ('snap', 'picker'),
            # One pick: nothing asked, nothing said -- the info line names the machine it is on now.
            ('keys', '\x1b[B'), ('keys', '\r'), ('wait_for', 'devbox  •', 60), ('settle', 2), ('snap', 'moved'),
            ('type', 'where are you now'), ('wait_for', 'Answered on devbox.', 60), ('settle', 1), ('snap', 'answered'),
            ('type', 'and again'), ('wait_for', 'Second answer on devbox.', 60), ('settle', 1), ('snap', 'again'),
            # Two bridges there so far: the window's (both boards, the list and the move) and the moved chat's own.
            ('expect_file_count', 'remote/ssh.log', 'ide-bridge --stdio', 2),
            # Its slash menu is devbox's: `/` shows it, with /machine; a command chosen runs there.
            ('keys', '/'), ('wait_for', '/model', 10), ('settle', 1), ('snap', 'menu'),
            ('keys', 'mach'), ('wait_for', '/machine', 10), ('settle', 0.5), ('snap', 'menu-machine'),
            ('keys', '\x7f\x7f\x7f\x7f'), ('settle', 0.5),
            ('keys', 'model grok-4-fast'), ('settle', 1), ('keys', '\r'), ('wait_for', 'grok-4-fast', 30), ('settle', 1), ('snap', 'model'),
            # Left: the chats of the machine this chat is on, devbox -- it is listed there.
            ('keys', '\x1b[D'), ('wait_for', 'hello there', 20), ('settle', 1), ('snap', 'board'),
            # Left again: the machines; this one's chats do not list it: it is live on devbox only.
            ('keys', '\x1b[D'), ('wait_for', 'devbox  · connected', 20), ('settle', 1),
            ('keys', '\x1b[A'), ('keys', '\x1b[C'), ('wait_for', '← machines', 20), ('settle', 1), ('snap', 'here'),
            # devbox lists it, and it opens there, live: the answer comes from devbox, and nothing moves.
            ('keys', '\x1b[D'), ('wait_for', 'devbox  · connected', 20), ('settle', 1),
            ('keys', '\x1b[B'), ('keys', '\x1b[C'), ('wait_for', 'hello there', 20), ('settle', 1), ('snap', 'there'),
            ('keys', '\x1b[C'), ('wait_for', 'Second answer on devbox.', 30), ('settle', 2),
            ('type', 'third time'), ('wait_for', 'Third answer on devbox.', 60), ('settle', 1), ('snap', 'live'),
            # Told once, with the first turn there; the second turn is only what was typed.
            ('expect_file_count', 'remote-prompts.log', 'This conversation moved from', 1),
            ('expect_file_count', 'remote-prompts.log', 'Earlier in this chat', 1),
            ('expect_file_count', 'remote-prompts.log', '"and again"', 1),
            ('expect_file_count', 'remote-prompts.log', '"third time"', 1),
            # One more: the chat's own again, opened from devbox's list (the board's lists went over the window's).
            ('expect_file_count', 'remote/ssh.log', 'ide-bridge --stdio', 3),
        ],
        'watch': [],
        'snap_contains': {
            'picker': ['Move this chat to', 'devbox'],
            'moved': ['devbox  •', 'hello there', 'First answer here.'],
            'answered': ['where are you now', 'Answered on devbox.'],
            'again': ['and again', 'Second answer on devbox.'],
            'menu': ['/model', '/provider'],
            'menu-machine': ['/machine', 'the machine this chat runs on'],
            'model': ['devbox  •', 'grok-4-fast'],
            'board': ['hello there'],
            'here': ['No conversations yet'],
            'there': ['hello there'],
            'live': ['devbox  •', 'grok-4-fast', 'and again', 'third time', 'Third answer on devbox.'],
        },
        'snap_lacks': {'moved': ['is not signed in', 'Moving to devbox', 'Moved to'], 'answered': ['moved from', 'clikcode_resource_note'],
                       'board': ['moved to'], 'here': ['hello there', 'moved to'], 'live': ['goes on here', 'read-only']},
        'never': ['ENOENT', 'This conversation moved from', 'clikcode_resource_note', 'Connection to devbox', 'Moved to devbox', 'Moving to devbox'],
    },
    # A chat on another machine over a slow link (devbox's every byte back
    # 2.5 s late): a message typed there is drawn at once, with the turn's
    # wait, as a chat here draws one -- not when the machine's turn-start
    # comes back. After the move only the prompt and its answer travel per
    # turn, not the conversation (src/ide/session-delta.ts), and the chat is
    # right after several turns.
    'remote-chat-small-sends': {
        'setup': remote_move(latency_ms=2500, count_bytes=True), 'startup': 4, 'no_dup_check': 'the transcript is drawn again on the other machine',
        'turns': [{'blocks': ['First answer here.']}],
        'steps': [
            ('type', 'hello there'), ('wait_for', 'First answer here.', 30), ('settle', 1),
            ('type', '/machine'), ('wait_for', 'Move this chat to', 30), ('wait_for', 'devbox', 10), ('settle', 1),
            ('keys', '\x1b[B'), ('keys', '\r'), ('wait_for', 'devbox  •', 90), ('settle', 6),
            ('bytes_mark', 'devbox'),
            ('type', 'where are you now'), ('wait_for', 'where are you now', 1), ('snap', 'early'),
            ('wait_for', 'Answered on devbox.', 60), ('settle', 4), ('expect_bytes_since', 'devbox', 30000),
            ('bytes_mark', 'devbox'),
            ('type', 'and again'), ('wait_for', 'and again', 1), ('snap', 'early2'),
            ('wait_for', 'Second answer on devbox.', 60), ('settle', 4), ('expect_bytes_since', 'devbox', 30000),
            ('bytes_mark', 'devbox'),
            ('type', 'third time'), ('wait_for', 'third time', 1), ('snap', 'early3'),
            ('wait_for', 'Third answer on devbox.', 60), ('settle', 4), ('expect_bytes_since', 'devbox', 30000), ('snap', 'end'),
            ('expect_file_count', 'remote-prompts.log', '"and again"', 1),
            ('expect_file_count', 'remote-prompts.log', '"third time"', 1),
        ],
        'watch': [],
        'snap_contains': {
            'early': ['hello there', 'First answer here.', 'where are you now', 'thinking'],
            'early2': ['Answered on devbox.', 'and again', 'thinking'],
            'early3': ['Second answer on devbox.', 'third time', 'thinking'],
            'end': ['where are you now', 'Answered on devbox.', 'and again', 'Second answer on devbox.', 'third time', 'Third answer on devbox.'],
        },
        'snap_lacks': {'early': ['Answered on devbox.'], 'early2': ['Second answer on devbox.'], 'early3': ['Third answer on devbox.']},
        'snap_once': {'end': ['where are you now', 'and again', 'third time', 'Answered on devbox.', 'Second answer on devbox.', 'Third answer on devbox.']},
        'never': ['ENOENT', 'Connection to devbox', 'Moved to devbox'],
    },
    # A machine nothing ClikCode can run runs on (macOS 10.12: no Node 22.12 for
    # it) is refused at the first step, before anything is downloaded, and the
    # whole reason is on screen: the step and what to do, not cut to one row.
    'remote-install-refused-old-macos': {
        'setup': remote_fake(host_options={'uname': {'s': 'Darwin', 'm': 'x86_64'}, 'swVers': '10.12.6', 'hide': ['node']}),
        'startup': 4, 'no_dup_check': 'lists and progress lines, no transcript',
        'turns': [{'blocks': ['unused']}],
        'steps': [
            ('settle', 2),
            ('type', '/machine'), ('wait_for', 'Move this chat to', 15), ('wait_for', 'macbook', 10), ('settle', 1), ('keys', '\x1b[B'),
            ('keys', '\r'), ('wait_for', 'Log in to devbox as which user?', 15), ('settle', 0.5),
            ('type', 'dev'), ('wait_for', 'add it again.', 30), ('settle', 1), ('snap', 'refused'),
        ],
        'watch': [],
        'snap_contains': {'refused': ['✗ Checking the machine: macOS 10.12.6 is too old for ClikCode', 'which needs macOS 10.15 or newer', 'Update macOS on dev@devbox.tail-fake.ts.net', 'there yourself and add it again.']},
        'snap_lacks': {'refused': ['2/6 Node.js', 'devbox is added']},
        'never': ['ENOENT', 'Getting ClikCode from GitHub'],
    },
    # The iMac seen live (macOS 10.15, Intel): its Homebrew node and an earlier
    # install's own Node are builds for a newer macOS and do not run. Neither
    # counts; MacPorts' Node 22 is installed instead (fake packages.macports.org,
    # fake otool / install_name_tool / codesign), run, and the install goes on.
    'remote-install-macports-node': {
        'setup': remote_fake(host_options={'uname': {'s': 'Darwin', 'm': 'x86_64'}, 'swVers': '10.15.8', 'appleTools': True,
                                           'brokenNode': 'dyld: Symbol not found (built for Mac OS X 13.5)', 'ownBrokenNode': 'dyld: Symbol not found (built for Mac OS X 13.5)'}),
        'startup': 4, 'no_dup_check': 'lists and progress lines, no transcript',
        'turns': [{'blocks': ['unused']}],
        'steps': [
            ('settle', 2),
            ('type', '/machine'), ('wait_for', 'Move this chat to', 15), ('wait_for', 'macbook', 10), ('settle', 1), ('keys', '\x1b[B'),
            ('keys', '\r'), ('wait_for', 'Log in to devbox as which user?', 15), ('settle', 0.5),
            ('type', 'dev'), ('wait_for', 'devbox  •', 90), ('settle', 1), ('snap', 'installed'),
        ],
        'watch': [],
        # Each step is said as it happens; then the chat opens there.
        'ever': ['1/6 Checking the machine · macOS 10.15.8 x86_64', '2/6 Node.js · v22.22.2 from MacPorts nodejs22 v22.22.2', 'SHA-256 pinned, runs',
                 "replaces ClikCode's own Node, which no longer ran", '5/6 Building and installing'],
        'snap_contains': {'installed': ['devbox  •']},
        'never': ['ENOENT', '✗'],
    },
    # A chat moved to a machine where its provider is installed but not signed in:
    # the first message there opens the sign-in -- its link drawn here, in the
    # chat -- and once it finishes that same message is answered on devbox. It is
    # never typed twice, and nothing asks for an account first.
    'remote-signin-send': {
        'setup': remote_move(remote_signed_in=False), 'startup': 4, 'no_dup_check': 'the transcript is drawn again on the other machine',
        'turns': [{'blocks': ['First answer here.']}],
        'steps': [
            ('type', 'hello there'), ('wait_for', 'First answer here.', 30), ('settle', 1),
            ('type', '/machine'), ('wait_for', 'Move this chat to', 30), ('wait_for', 'devbox', 10), ('settle', 1),
            ('keys', '\x1b[B'), ('keys', '\r'), ('wait_for', 'devbox  •', 60), ('settle', 3),
            ('type', 'where are you now'), ('wait_for', 'AB12-CD34', 60), ('settle', 0.5), ('snap', 'link'),
            ('wait_for', 'Answered on devbox.', 60), ('settle', 2), ('snap', 'answered'),
            # The message went to the agent once, after the sign-in: not sent twice, not lost.
            ('expect_file_count', 'remote-prompts.log', 'where are you now', 1),
        ],
        'watch': [],
        'snap_contains': {'link': ['where are you now', 'accounts.x.ai/oauth2/device', 'AB12-CD34'],
                          'answered': ['where are you now', 'Answered on devbox.']},
        'snap_lacks': {'answered': ['did not finish', 'not signed in']},
        'never': ['ENOENT', 'not a tty', 'Grok Build accounts', 'did not finish'],
    },
    # A message that cannot reach its turn on the other machine (its worker will
    # not start there): it is drawn on Enter, then put back in the message box,
    # and why is said -- not wiped with the wait it was drawn in.
    'remote-send-fails-back': {
        'setup': remote_move(remote_env={'CLIKCODE_WORKER_ENTRY': '/nonexistent/clikcode.js'}), 'startup': 4,
        'no_dup_check': 'the transcript is drawn again on the other machine',
        'turns': [{'blocks': ['First answer here.']}],
        'steps': [
            ('type', 'hello there'), ('wait_for', 'First answer here.', 30), ('settle', 1),
            ('type', '/machine'), ('wait_for', 'Move this chat to', 30), ('wait_for', 'devbox', 10), ('settle', 1),
            ('keys', '\x1b[B'), ('keys', '\r'), ('wait_for', 'devbox  •', 60), ('settle', 3),
            ('type', 'where are you now'), ('wait_for', 'thinking', 10), ('wait_for_gone', 'thinking', 40), ('settle', 2), ('snap', 'back'),
        ],
        'watch': [],
        'snap_contains': {'back': ['› where are you now', 'worker']},
        'never': ['ENOENT'],
    },
    # A chat on a machine whose ClikCode is another build: said once on opening it, with where
    # to update it. Nothing is updated without the user.
    'remote-outdated-chat-notice': {
        'setup': remote_fake(commit='0' * 40), 'startup': 4, 'no_dup_check': 'lists and progress lines, no transcript',
        'turns': [{'blocks': ['unused']}],
        'steps': [
            ('settle', 2),
            ('type', '/machine'), ('wait_for', 'Move this chat to', 15), ('wait_for', 'macbook', 10), ('settle', 1), ('keys', '\x1b[B'),
            ('keys', '\r'), ('wait_for', 'Log in to devbox as which user?', 15), ('settle', 0.5),
            # Added from /machine, its chat opens there at once, and says so.
            ('type', 'dev'), ('wait_for', 'runs another ClikCode build', 60), ('settle', 1), ('snap', 'opened'),
        ],
        'watch': [],
        'snap_contains': {'opened': ['devbox runs another ClikCode build than this one']},
        # Added from /machine it is kept up to date by itself: it says so, and (this fake
        # repository has no commit of this build) that it could not, and what to type.
        'ever': ['could not be updated -- type /update to try again'],
        'never': ['ENOENT'],
    },
    # A machine on an older commit than this build is brought to this build's
    # commit by itself (policy automatic, the default): the board's machine
    # list says it is updating, then it is current. Nothing asks.
    'remote-auto-update': {
        'setup': remote_installed('auto', pnpm_delay=8), 'startup': 4, 'no_dup_check': 'lists and progress lines, no transcript',
        'turns': [{'blocks': ['unused']}],
        'steps': [
            ('settle', 2),
            ('keys', '\x1b[D'), ('wait_for', '← machines', 20), ('keys', '\x1b[D'), ('wait_for', 'devbox', 20),
            ('wait_for', 'updating ClikCode', 30), ('snap', 'updating'),
            ('wait_for_gone', 'updating ClikCode', 90), ('wait_for', '2 chats', 20), ('settle', 1), ('snap', 'current'),
        ],
        'watch': [],
        'snap_contains': {'updating': ['devbox', 'updating ClikCode…'], 'current': ['devbox', 'connected · 2 chats']},
        'snap_lacks': {'current': ['needs update', 'update failed', 'updating']},
        'never': ['ENOENT', 'update failed'],
    },
    # Set to ask first, the same machine is only said to need an update; in one
    # of its chats `/update` updates it there (its real ClikCode, on that
    # machine), step by step, from its commit to main's.
    'remote-ask-update': {
        'setup': remote_installed('ask'), 'startup': 4, 'no_dup_check': 'lists and progress lines, no transcript',
        'turns': [{'blocks': ['unused']}],
        'steps': [
            ('settle', 2),
            ('keys', '\x1b[D'), ('wait_for', '← machines', 20), ('keys', '\x1b[D'), ('wait_for', 'needs update', 30), ('settle', 3), ('snap', 'machines'),
            ('keys', '\x1b[B'), ('keys', '\x1b[C'), ('wait_for', 'Fix the login page', 20), ('settle', 0.5),
            ('keys', '\x1b[C'), ('wait_for', 'Type /update', 15), ('snap', 'opened'),
            ('type', '/update'), ('wait_for', 'chats switch over once they are quiet', 120), ('settle', 1), ('snap', 'updated'),
            ('keys', '\x1b[D'), ('wait_for', '← machines', 20), ('keys', '\x1b[D'), ('wait_for', '2 chats', 30), ('settle', 3), ('snap', 'after'),
        ],
        'watch': [],
        'snap_contains': {
            'machines': ['devbox', 'needs update (/machine)'],
            'opened': ['devbox runs another ClikCode build than this one. Type /update to update it'],
            # "on <host>": the fake machines share this one's hostname.
            'updated': ['1/3 Getting ClikCode from GitHub', '2/3 Building and installing', '3/3 Checking the install', '→', '; chats switch over once they are quiet.'],
            'after': ['devbox', 'connected · 2 chats'],
        },
        'snap_lacks': {'machines': ['updating ClikCode'], 'after': ['needs update']},
        'never': ['ENOENT', 'updating ClikCode…'],
    },
    # A sign-in in a chat on another machine, as Claude Code's: its link on a
    # card, then its own question ("Paste code here if prompted"). The
    # question is asked under the link, which stays on screen until it is
    # answered; it used to end the wait the link is drawn in, leaving only a
    # key prompt.
    'remote-chat-sign-in-keeps-link': {
        'setup': remote_installed('ask', current=True), 'startup': 4, 'no_dup_check': 'lists and progress lines, no transcript',
        'turns': [{'blocks': ['unused']}],
        'steps': [
            ('settle', 2),
            ('keys', '\x1b[D'), ('wait_for', '← machines', 20), ('keys', '\x1b[D'), ('wait_for', '2 chats', 30), ('settle', 1),
            ('keys', '\x1b[B'), ('keys', '\x1b[C'), ('wait_for', 'Fix the login page', 20), ('settle', 0.5),
            ('keys', '\x1b[C'), ('settle', 3),
            ('type', 'sign in'), ('wait_for', 'Paste code here if prompted', 15), ('settle', 2), ('snap', 'asked'),
            ('type', 'abc123'), ('wait_for', 'Signed in with code abc123', 15), ('settle', 1), ('snap', 'done'),
        ],
        'watch': [],
        'snap_contains': {
            'asked': ['Sign in to Claude Code', 'https://claude.ai/oauth/authorize', 'Paste code here if prompted'],
            'done': ['Signed in with code abc123'],
        },
        'snap_lacks': {'done': ['https://claude.ai/oauth/authorize']},
        'never': ['ENOENT', 'Sign-in cancelled'],
    },
    # The machine's ClikCode is updated while one of its chats is open here and quiet: the
    # bridge there leaves for the new build (src/ide/bridge-retire.ts, emulated by
    # fake-remote-clikcode.mjs), and the chat connects again to a new bridge process and goes on --
    # nothing said, what was being typed still in the composer.
    'remote-chat-bridge-rebuild': {
        'setup': remote_installed('ask', current=True), 'startup': 4, 'no_dup_check': 'lists and progress lines, no transcript',
        'turns': [{'blocks': ['unused']}],
        'steps': [
            ('settle', 2),
            ('keys', '\x1b[D'), ('wait_for', '← machines', 20), ('keys', '\x1b[D'), ('wait_for', '2 chats', 30), ('settle', 1),
            ('keys', '\x1b[B'), ('keys', '\x1b[C'), ('wait_for', 'Fix the login page', 20), ('settle', 0.5),
            ('keys', '\x1b[C'), ('settle', 3),
            ('type', 'say: before the update'), ('wait_for', 'Said: before the update', 15), ('settle', 1),
            ('keys', 'say: after the update'), ('settle', 1), ('snap', 'typed'),
            ('remote_rebuild', 'devbox.tail-fake.ts.net'),
            ('expect_remote_opens', 'devbox.tail-fake.ts.net', 'c1', 2, 30), ('settle', 2), ('snap', 'rejoined'),
            ('keys', '\r'), ('wait_for', 'Said: after the update', 15), ('settle', 1), ('snap', 'after'),
        ],
        'watch': [],
        'snap_contains': {
            'typed': ['› say: after the update'],
            'rejoined': ['Said: before the update', '› say: after the update'],
            'after': ['Said: before the update', 'Said: after the update'],
        },
        'snap_lacks': {'rejoined': ['another ClikCode build', 'closed', 'Connection to']},
        'never': ['This conversation closed', 'Connection to devbox', 'interrupted', 'ENOENT', 'No answer from'],
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
        
    },
    # A notice ClikCode sends the model in the user's place is not drawn at
    # all: not as the user's `›`, not as a notice.
    'clikcode-notice-row': {
        'turns': [{'blocks': ['Nothing needs restarting.']}],
        # Typed here to stand in for the worker's queued notice; once sent
        # (the composer is empty again) it is never drawn as the user's.
        'steps': [('type', '[ClikCode] Background work was stopped: a test.'), ('mark',),
                  ('wait_for', 'Nothing needs restarting.', 30), ('settle', 3)],
        'watch': ['Nothing needs restarting.'],
        'final_contains': ['Nothing needs restarting.'],
        'never_after_mark': ['› [ClikCode]', '[ClikCode] Background', 'ClikCode notice', 'Background work was stopped'],
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
    # A structured-CLI harness on the generic JSON reader (Command Code moved to ACP, so OpenClaw stands in).
    'generic-json-two-blocks': {
        'harness': 'openclaw', 'family': 'generic',
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
        # The typed command is applied (the footer says so), and nothing more is said.
        'never': ['/model grok-4-fast · applied'],
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
        'shown_outside_board': ['run the long job'],
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
        # Rejoined, the turn is drawn with every call it made -- twelve calls are one folded row
        # now, so it is that row (all twelve counted) and the answer that are held to once.
        'watch': [], 'final_once': ['Ran 12 commands', 'All twelve parts pass.'],
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
    # it -- starting on the current value; the change is not announced.
    'slash-command-opens-picker': {
        'turns': [TWO_BLOCKS],
        'steps': [('keys', '/effort'), ('settle', 1), ('keys', '\r'), ('wait_for', 'Reasoning effort', 10), ('settle', 0.5),
                  ('keys', '\x1b[B'), ('settle', 0.5), ('keys', '\r'), ('settle', 2)],
        'watch': [], 'ever': ['❯ Medium  · current'], 'never': ['Effort set to High'],
        'never_together': [('› /effort', 'Reasoning effort'), ('tab complete · enter run', 'Reasoning effort')],
    },
    # What runs is what is highlighted: a typed command starts highlighted,
    # and its picker replaces it.
    # /resume is not in the terminal's list (← is the board), and `/res`
    # does not land on /compact ("f-res-h"); typed out, it opens the board.
    'slash-resume-opens-board': {
        'turns': [{'blocks': ['First chat answered.']}],
        'steps': [('type', 'hello'), ('wait_for', 'First chat answered.', 30), ('settle', 2),
                  ('keys', '/res'), ('settle', 1), ('snap', 'palette'), ('keys', '\x7f' * 4), ('settle', 0.5),
                  ('type', '/resume'), ('wait_for', 'Recent', 10), ('settle', 1), ('snap', 'board')],
        'watch': [], 'snap_contains': {'board': ['enter open']}, 'snap_lacks': {'palette': ['/resume', '❯ /compact']},
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
    # Del on a signed-in account signs it out at once, as /logout does (it is
    # undone by signing in): the row turns to reauth, the vendor's own logout
    # ran, and a line says so.
    'account-del-disconnects': {
        'turns': [TWO_BLOCKS],
        # Signed in by the first message: nothing signs in at launch.
        'steps': [('type', 'please check the commit'), ('wait_for', 'The final commit is live.', 40), ('settle', 1),
                  ('keys', '/account'), ('settle', 1), ('keys', '\r'), ('wait_for', 'Grok Build accounts', 10), ('settle', 2),
                  ('keys', '\x1b[3~'), ('wait_for', 'reauth', 15), ('settle', 1)],
        'watch': [], 'ever': ['del disconnect'], 'final_contains': ['reauth'],
        'never': ['Cancel', 'Signed out of Grok Build'],
    },
    # Signing in from the account list (Tab → Reauthenticate) closes it: that
    # account is the chat's now, and nothing is left to do there. Signing out
    # (Del) shows the list again, with the change.
    'account-sign-in-closes-list': {
        'turns': [TWO_BLOCKS],
        'steps': [('type', 'please check the commit'), ('wait_for', 'The final commit is live.', 40), ('settle', 1),
                  ('keys', '/account'), ('settle', 1), ('keys', '\r'), ('wait_for', 'Grok Build accounts', 10), ('settle', 2),
                  ('keys', '\x1b[3~'), ('wait_for', 'reauth', 15), ('settle', 1), ('snap', 'signed-out'),
                  ('keys', '\t'), ('wait_for', 'Reauthenticate', 10), ('settle', 0.5), ('keys', '\r'),
                  ('wait_for', 'AB12-CD34', 15), ('wait_for_gone', 'AB12-CD34', 30), ('settle', 2), ('snap', 'after')],
        'watch': [],
        'snap_contains': {'signed-out': ['Grok Build accounts', 'reauth']},
        'snap_lacks': {'after': ['Grok Build accounts', 'reauth']},
        'never': ['did not finish'],
    },
    # The same from a Mac or iPhone, whose "delete" key sends Backspace.
    'account-backspace-disconnects': {
        'turns': [TWO_BLOCKS],
        # Signed in by the first message: nothing signs in at launch.
        'steps': [('type', 'please check the commit'), ('wait_for', 'The final commit is live.', 40), ('settle', 1),
                  ('keys', '/account'), ('settle', 1), ('keys', '\r'), ('wait_for', 'Grok Build accounts', 10), ('settle', 2),
                  ('keys', '\x7f'), ('wait_for', 'reauth', 15), ('settle', 1)],
        'watch': [], 'ever': ['del disconnect'], 'final_contains': ['reauth'],
        'never': ['Cancel', 'Signed out of Grok Build'],
    },
    # Adding a Grok account: its sign-in is a link and a code, shown on
    # ClikCode's own screen -- the vendor's own text never takes it over.
    'account-add-link-sign-in': {
        'turns': [TWO_BLOCKS],
        'steps': [('keys', '/account'), ('settle', 1), ('keys', '\r'), ('wait_for', 'Grok Build accounts', 10), ('settle', 2),
                  ('keys', '\x1b[B'), ('settle', 0.5), ('keys', '\r'), ('wait_for', 'the code AB12-CD34', 15),
                  ('settle', 5)],
        'watch': [], 'ever': ['Sign in to Grok Build · confirm the code AB12-CD34', 'https://accounts.x.ai/oauth2/device?user_code=AB12-CD34', 'waiting for you to sign in'],
        'never': ['signed in to', 'Confirm this code in your browser', 'Waiting for authorization', 'not a tty'],
    },
    # A sign-in that asks for a key: asked under ClikCode's band, typed
    # there as dots, never the vendor's own prompt on screen.
    'account-add-key-sign-in': {
        'turns': [TWO_BLOCKS],
        'env': {'FAKE_LOGIN_KEY': 'sk-test-42'},
        # Signed out: the first message signs in, then is answered.
        'steps': [('type', 'please check the commit'), ('wait_for', 'type it and press Enter', 15), ('settle', 0.5),
                  ('keys', 'sk-test-42'), ('settle', 0.5), ('keys', '\r'),
                  ('wait_for', 'The final commit is live.', 40), ('settle', 1)],
        'watch': [], 'ever': ['Paste your API key · type it and press Enter', '••••••••••'],
        'final_contains': ['The final commit is live.'], 'never': ['signed in to', 'sk-test-42', 'Paste your API key: ', 'did not finish'],
    },
    # A question with a shown default after the key (Hermes's `Base URL
    # [...]:`): Enter alone answers it -- a stray Enter on the key does not.
    'key-sign-in-default-answer': {
        'turns': [TWO_BLOCKS],
        'env': {'FAKE_LOGIN_KEY': 'sk-test-42', 'FAKE_LOGIN_DEFAULT': '1'},
        'steps': [('type', 'please check the commit'), ('wait_for', 'type it and press Enter', 15), ('settle', 0.5),
                  ('keys', '\r'), ('settle', 0.5), ('keys', 'sk-test-42'), ('settle', 0.5), ('keys', '\r'),
                  ('wait_for', 'Base URL', 15), ('settle', 0.5), ('keys', '\r'),
                  ('wait_for', 'The final commit is live.', 40), ('settle', 1)],
        'watch': [], 'ever': ['Paste your API key · type it and press Enter', 'Base URL [https://api.example.test/v1] · type it and press Enter'],
        'final_contains': ['The final commit is live.'], 'never': ['signed in to', 'sk-test-42', 'did not finish'],
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
    # does: nothing is said of it, and the message goes back
    # to the composer to send again.
    'esc-cancels-sign-in': {
        'cols': 70,
        'turns': [TWO_BLOCKS],
        'hold_sign_in': True,
        'steps': [('type', 'start the work'), ('wait_for', 'waiting for you to sign in', 30), ('settle', 0.5), ('snap', 'band'),
                  ('keys', '\x1b'), ('settle', 3), ('snap', 'after')],
        'watch': [], 'snap_contains': {'band': ['esc cancel'], 'after': ['› start the work']},
        'never': ['Sign-in to Grok Build cancelled', 'Error:', 'did not finish', 'Stopped'],
    },
    # A sign-in waits on the user, as an approval does: the band holds still
    # -- a ●, never a spinner frozen mid-step -- and its clock is stopped.
    'sign-in-band-holds-still': {
        'turns': [TWO_BLOCKS],
        'hold_sign_in': True,
        'steps': [('type', 'start the work'), ('wait_for', 'waiting for you to sign in', 30), ('settle', 3),
                  ('release_sign_in',), ('wait_for', 'The final commit is live.', 40), ('settle', 1)],
        'watch': [], 'ever': ['● waiting for you to sign in to Grok Build'],
        'never_pattern': [r'[\u2800-\u28ff]{2}  waiting for you to sign in', r'waiting for you to sign in to Grok Build · \d+s'],
    },
    # A slow wait's band, once shown, stays long enough to read: a command
    # just past SLOW_WAIT_MS used to flash its band for a frame or two.
    'slow-wait-band-stays-readable': {
        'turns': [TWO_BLOCKS],
        'steps': [('type', '!sleep 0.45'), ('settle', 3)],
        # The band's own line ("! sleep 0.45 · 0s"): the composer shows the
        # same words while they are typed, since `!` opens with a space.
        'watch': [], 'ever': ['! sleep 0.45 · '], 'min_visible': {'! sleep 0.45 · ': 0.28},
    },
    # Ctrl+C in a sign-in's key field: one press cancels it, said the same way.
    'ctrl-c-cancels-key-sign-in': {
        'cols': 70,
        'turns': [TWO_BLOCKS],
        'env': {'FAKE_LOGIN_KEY': 'sk-test-42'},
        'steps': [('type', 'start the work'), ('wait_for', 'type it and press Enter', 15), ('settle', 0.5),
                  ('keys', '\x03'), ('settle', 3), ('snap', 'after')],
        'watch': [], 'snap_contains': {'after': ['› start the work']},
        'never': ['Sign-in to Grok Build cancelled', 'Error:', 'did not finish'],
    },
    # Adding an account from /account: Esc cancels its sign-in too.
    'esc-cancels-account-sign-in': {
        'turns': [TWO_BLOCKS],
        'hold_sign_in': True,
        'steps': [('keys', '/account'), ('settle', 1), ('keys', '\r'), ('wait_for', 'Grok Build accounts', 10), ('settle', 2),
                  ('keys', '\x1b[B'), ('settle', 0.5), ('keys', '\r'), ('wait_for', 'the code AB12-CD34', 15), ('settle', 0.5),
                  ('keys', '\x1b'), ('settle', 3), ('snap', 'after')],
        'watch': [], 'never': ['Sign-in to Grok Build cancelled', 'Error:', 'did not finish'],
        'snap_lacks': {'after': ['› /account']},
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
        'never': ['signed in to'],
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
        'never': ['signed in to'],
    },
    # Back from a sub-menu lands on the row it was opened from, with no
    # spinner or empty composer flashed on the way into the list.
    'settings-back-lands-on-row': {
        'turns': [TWO_BLOCKS],
        'steps': [('keys', '/settings'), ('settle', 1), ('keys', '\r'), ('wait_for', 'Account', 10), ('settle', 0.5),
                  ('keys', '\x1b[B'), ('settle', 0.3), ('keys', '\x1b[B'), ('settle', 0.5), ('keys', '\r'),
                  ('wait_for', 'Choose a model', 10), ('settle', 0.5), ('keys', '\x1b[D'), ('settle', 1.5)],
        'watch': [], 'final_contains': ['❯ Model'], 'never': ['finding Grok Build models'],
    },
    # A sign-in that worked leaves no line, and never a "signing in" line
    # that stays.
    'sign-in-outcome': {
        'turns': [TWO_BLOCKS],
        'steps': [('type', 'please check the commit'), ('wait_for', 'The final commit is live.', 40), ('settle', 1)],
        'watch': [], 'never': ['signed in to Grok Build', 'signing in to Grok Build'],
    },
    # A command that prints while it runs: its newest lines show under the
    # spinner, and stay -- its first and last, the middle counted -- once a
    # completion that carries no output of its own settles the row.
    'streamed-tool-output': {
        'env': {'FAKE_DELAY_MS': '60'},
        'turns': [{'streamed_tool': {'lines': [f'test file {n} passed' for n in range(1, 9)], 'ms': 700}, 'blocks': ['All the tests pass.']}],
        'steps': [('type', 'run the tests'), ('wait_for', 'All the tests pass.', 40), ('settle', 2), ('snap', 'done')],
        # A successful call is its row; its output is in the saved turn, not under the call.
        'watch': [], 'final_contains': ['All the tests pass.'],
        'snap_lacks': {'done': ['test file 3 passed', 'lines hidden']},
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
        'final_once': ['Read 2 files, searched 1 pattern'],
        'never': ['build step 15 of 30', 'lines hidden'],
    },
    # A run of calls and thoughts with no prose between them settles as ONE
    # summary row (counts by kind), and the items stay reachable: a tap on the
    # row, or Ctrl+O, lists them IN PLACE under it; a tap on an item opens its
    # full command and output under it; a tap again minimises.
    'call-group-collapses': {
        'turns': [{'emits': [
            {'op': 'thought', 'heading': 'Planning the work', 'text': 'First look around.', 'ms': 20},
            {'op': 'tool', 'id': 'g1', 'title': 'echo alpha-one', 'ms': 200, 'result': 'alpha-one'},
            {'op': 'tool-start', 'id': 'g2', 'title': 'Read src/beta.ts', 'kind': 'read', 'input': {'path': 'src/beta.ts'}},
            {'op': 'tool-end', 'id': 'g2', 'result': 'b0\nb1'},
            {'op': 'tool', 'id': 'g3', 'title': 'echo gamma-three', 'ms': 200, 'result': 'gamma-three'},
            {'op': 'thought', 'text': 'Now conclude.', 'ms': 20},
            {'op': 'tool', 'id': 'g4', 'title': 'echo delta-four', 'ms': 200, 'result': 'delta-four'},
            {'op': 'text', 'text': 'The calls are all done.'},
        ]}],
        'steps': [('type', 'run the calls'), ('wait_for', 'The calls are all done.', 40), ('settle', 2), ('snap', 'final'),
                  ('click', 'Ran 3 commands'), ('settle', 0.8), ('snap', 'opened'),
                  ('click', 'Ran 3 commands'), ('settle', 0.8), ('snap', 'minimised')],
        'watch': ['run the calls', 'The calls are all done.'],
        'final_once': ['Ran 3 commands, read 1 file', '2 thoughts'],
        # The calls are inside the group, not rows of their own; a tap lists them under it, a second minimises it.
        'snap_lacks': {'final': ['echo alpha-one', 'echo gamma-three', 'Thought for'], 'minimised': ['echo alpha-one', 'Thought for']},
        'snap_contains': {'opened': ['tap to collapse', 'echo alpha-one', 'echo gamma-three', 'echo delta-four', 'Thought for']},
    },
    'call-group-panel': {
        # The group is mid-screen with prose under it: opening it must grow the
        # group where it is, keep its row on the same screen row, and put nothing
        # new at the bottom above the composer.
        'turns': [{'emits': [
            *[{'op': 'text', 'text': f'earlier paragraph {n} came first.\n\n', 'ms': 5} for n in range(1, 13)],
            {'op': 'tool', 'id': 'g1', 'title': 'echo alpha-one', 'ms': 200, 'result': 'alpha-one'},
            {'op': 'tool-start', 'id': 'g2', 'title': 'Read src/beta.ts', 'kind': 'read', 'input': {'path': 'src/beta.ts'}},
            {'op': 'tool-end', 'id': 'g2', 'result': 'b0\nb1'},
            {'op': 'tool', 'id': 'g3', 'title': 'echo gamma-three', 'ms': 200, 'result': 'gamma-three\nline two of gamma'},
            *[{'op': 'text', 'text': f'prose paragraph {n} follows.\n\n', 'ms': 5} for n in range(1, 4)],
            {'op': 'text', 'text': 'The calls are all done.'},
        ]}],
        # A short screen, so the transcript is taller than it and the group is mid-screen.
        'rows': 24,
        'steps': [
            ('type', 'run the calls'), ('wait_for', 'The calls are all done.', 40), ('settle', 2), ('snap', 'closed'),
            ('click', 'Ran 2 commands'), ('settle', 0.8), ('snap', 'opened'),
            ('click', 'echo gamma-three'), ('settle', 0.8), ('snap', 'item'),
            ('click', 'echo gamma-three'), ('settle', 0.8), ('snap', 'item-closed'),
            ('click', 'Ran 2 commands'), ('settle', 0.8), ('snap', 'minimised'),
            ('keys', '\x0f'), ('settle', 0.8), ('snap', 'ctrl-o'),
            ('keys', '\x0f'), ('settle', 0.8), ('snap', 'ctrl-o-closed'),
        ],
        'watch': [],
        'snap_contains': {
            'closed': ['Ran 2 commands, read 1 file · tap'],
            'opened': ['tap to collapse', 'echo alpha-one', 'Read src/beta.ts', 'echo gamma-three'],
            'item': ['line two of gamma'],
            'ctrl-o': ['tap to collapse', 'echo alpha-one', 'echo gamma-three'],
        },
        'snap_lacks': {
            'closed': ['echo alpha-one', 'tap to collapse'], 'opened': ['line two of gamma'], 'item-closed': ['line two of gamma'],
            'minimised': ['echo alpha-one', 'tap to collapse'], 'ctrl-o-closed': ['echo alpha-one', 'tap to collapse'],
        },
        # The group's row never moves, whichever way it is toggled.
        'snap_same_row': [(name, 'Ran 2 commands') for name in ('opened', 'item', 'item-closed', 'minimised', 'ctrl-o', 'ctrl-o-closed')],
        # The items are listed directly under the row, the opened item's detail under its own row.
        'snap_rows_after': {
            'opened': ('Ran 2 commands', ['echo alpha-one', 'Read src/beta.ts', 'echo gamma-three']),
            'item': ('Read src/beta.ts', ['echo gamma-three', 'echo gamma-three', 'gamma-three', 'line two of gamma']),
        },
        # Nothing of the group appears at the bottom, above the composer.
        'snap_bottom_lacks': {'opened': ['echo alpha-one', 'echo gamma-three', 'tap to collapse'], 'item': ['line two of gamma']},
    },
    # A sub-agent is a row that opens in place: its task, each call it made
    # (a row of its own, one level in, that opens to its output), and its answer.
    'subagent-expands-in-place': {
        'turns': [{'emits': [
            *[{'op': 'text', 'text': f'earlier paragraph {n} came first.\n\n', 'ms': 5} for n in range(1, 13)],
            {'op': 'agent-start', 'id': 'ag1', 'title': 'Task: scan the parser', 'description': 'scan the parser for tokens'},
            {'op': 'child-start', 'id': 'c1', 'parent': 'ag1', 'title': 'Read src/lexer.ts', 'kind': 'read', 'input': {'file_path': 'src/lexer.ts'}},
            {'op': 'child-end', 'id': 'c1', 'parent': 'ag1', 'result': 'lexer-body'},
            {'op': 'child-start', 'id': 'c2', 'parent': 'ag1', 'title': 'echo child-two', 'kind': 'execute', 'input': {'command': 'echo child-two'}},
            {'op': 'child-end', 'id': 'c2', 'parent': 'ag1', 'result': 'child-two-output'},
            {'op': 'agent-end', 'id': 'ag1', 'result': 'The scan found lexer.ts'},
            *[{'op': 'text', 'text': f'prose paragraph {n} follows.\n\n', 'ms': 5} for n in range(1, 4)],
            {'op': 'text', 'text': 'The agent is done.'},
        ]}],
        'rows': 24,
        'steps': [
            ('type', 'scan the parser'), ('wait_for', 'The agent is done.', 40), ('settle', 2), ('snap', 'closed'),
            ('click', 'Agent scan'), ('settle', 0.8), ('snap', 'opened'),
            ('click', 'echo child-two'), ('settle', 0.8), ('snap', 'child'),
            ('click', 'echo child-two'), ('settle', 0.8), ('snap', 'child-closed'),
            ('click', 'Agent scan'), ('settle', 0.8), ('snap', 'minimised'),
        ],
        'watch': [],
        'snap_contains': {
            'opened': ['Read src/lexer.ts', 'echo child-two', 'The scan found lexer.ts'],
            'child': ['child-two-output'],
            'child-closed': ['echo child-two'],
        },
        'snap_lacks': {
            'closed': ['Read src/lexer.ts', 'child-two', 'The scan found lexer.ts'], 'opened': ['child-two-output'],
            'child-closed': ['child-two-output'], 'minimised': ['Read src/lexer.ts', 'child-two', 'The scan found lexer.ts'],
        },
        'snap_same_row': [(name, 'Agent scan') for name in ('opened', 'child', 'child-closed', 'minimised')],
        'snap_rows_after': {'opened': ('Agent scan', ['scan the parser for tokens', 'Read src/lexer.ts', 'echo child-two'])},
    },
    # A sub-agent still running, opened in place and taller than the screen:
    # scrolling back reaches its top (its header, where a tap minimises it).
    'running-agent-scrolls-to-its-top': {
        'rows': 24,
        'turns': [{'emits': [
            {'op': 'agent-start', 'id': 'ag1', 'title': 'Task: scan the parser', 'description': 'scan the parser for tokens'},
            *[item for n in range(1, 31) for item in (
                {'op': 'child-start', 'id': f'c{n}', 'parent': 'ag1', 'title': f'Read src/part{n}.ts', 'kind': 'read', 'input': {'file_path': f'src/part{n}.ts'}},
                {'op': 'child-end', 'id': f'c{n}', 'parent': 'ag1', 'result': f'body{n}'})],
            {'op': 'sleep', 'ms': 14000},
            {'op': 'agent-end', 'id': 'ag1', 'result': 'The scan found everything'},
            {'op': 'text', 'text': 'The agent is done.'},
        ]}],
        'steps': [
            ('type', 'scan the parser'), ('wait_for', 'Agent scan', 40), ('settle', 1),
            ('click', 'Agent scan'), ('settle', 1), ('snap', 'opened'),
            *[step for _ in range(8) for step in (('keys', '\x1b[<64;35;12M'), ('settle', 0.4))], ('settle', 1), ('snap', 'scrolled'),
            ('click', 'Agent scan'), ('settle', 1), ('snap', 'minimised'),
        ],
        'watch': [],
        'snap_contains': {'scrolled': ['Agent scan', 'scan the parser for tokens']},
        'snap_lacks': {'minimised': ['Read src/part3.ts']},
    },
    # A lone command opens too: its full command and the tail of its output.
    'lone-call-expands': {
        'turns': [{'emits': [
            {'op': 'tool', 'id': 'l1', 'title': 'echo lone-one && echo the-rest-of-the-command', 'ms': 200, 'result': 'lone-one\nlone-two-output'},
            {'op': 'text', 'text': 'The command is done.'},
        ]}],
        'steps': [
            ('type', 'run it'), ('wait_for', 'The command is done.', 40), ('settle', 2), ('snap', 'closed'),
            ('click', 'echo lone-one'), ('settle', 0.8), ('snap', 'opened'),
            ('click', 'echo lone-one'), ('settle', 0.8), ('snap', 'minimised'),
        ],
        'watch': [],
        'snap_contains': {'closed': ['echo lone-one'], 'opened': ['lone-two-output', 'the-rest-of-the-command']},
        'snap_lacks': {'closed': ['lone-two-output'], 'minimised': ['lone-two-output']},
    },
    # An edit is one row; tapped, it shows its diff.
    'edit-diff-on-tap': {
        'turns': [{'edits': [{'path': 'notes.txt', 'old': 'alpha\nbeta\n', 'new': 'alpha\nGAMMA\n'}], 'blocks': ['Edited the notes.']}],
        'steps': [
            ('type', 'edit the notes'), ('wait_for', 'Edited the notes.', 30), ('settle', 2), ('snap', 'closed'),
            ('click', 'notes.txt'), ('settle', 0.8), ('snap', 'opened'),
            ('click', 'notes.txt'), ('settle', 0.8), ('snap', 'minimised'),
        ],
        'watch': [],
        'snap_contains': {'opened': ['+ GAMMA', '- beta']},
        'snap_lacks': {'closed': ['+ GAMMA'], 'minimised': ['+ GAMMA']},
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
        'watch': ['clean and release', 'Answers: reject, reject.', 'Releasing with pnpm now.',
                  '✗ denied make clean', '↳ told: use pnpm instead'],
        # While an approval waits the line is a still dot and no clock.
        'ever': ['● waiting for you'],
        # Each decision leaves one settled row at its place.
        'final_once': ['✗ denied make clean', '↳ told: use pnpm instead'],
    },
    # Ctrl+C with an approval open denies it AND stops the turn: the model
    # does not go on to its next call.
    'ctrl-c-on-approval-stops-turn': {
        'turns': [{'permissions': ['make clean', 'make release'], 'blocks': ['Answers: {answers}.']}],
        'steps': [
            ('type', 'clean and release'), ('wait_for', 'Approval 1 of 2', 30), ('settle', 0.6),
            ('keys', '\x03'), ('settle', 4),
        ],
        'watch': [],
        # No answer yet: the prompt comes back to edit, the model never goes on.
        'never': ['Approval 2 of 2', 'Answers: ', 'Worked for'],
        'final_contains': ['› clean and release'],
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
            ('type', '/send queue'), ('settle', 2),
            ('type', 'start the long job'), ('wait_for', 'Step one of', 30),
            ('type', 'then do this'), ('wait_for', 'enter again send into the chat', 10), ('keys', '\r'),
            ('wait_for', 'Steered in: then do this.', 40), ('settle', 3),
        ],
        'watch': ['start the long job', 'Steered in: then do this.'],
        'ever': ['↳ steered'],
        'never': ['The queued one answered now.', 'stopping', 'Stopped', 'sent into the turn', 'Steer received:', 'Delivered to the model:'],
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
        'ever': ['sending at the next pause', '↳ steered'],
        # Held for the pause already: Enter again would do nothing, so it is
        # not offered.
        'never': ['Request interrupted', 'Queued turn answered.', 'stopping', 'enter again', 'sent into the turn', 'Steer received:', 'Delivered to the model:'],
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
    # Esc takes the message back and the SAME text is sent again: it is drawn
    # once, the whole way, and is not lost between the take-back and the send.
    'esc-then-resubmit-steer': {
        'env': {'FAKE_STEERING': '1', 'FAKE_DELAY_MS': '150'},
        'turns': [{'intro': 'Starting the long build.', 'hold_ms': 6000, 'blocks': ['The build passed.']},
                  {'blocks': ['Queued turn answered.']}],
        'steps': [
            ('type', 'start the build'), ('wait_for', 'sleep 30', 30),
            ('type', 'also run the linter'), ('wait_for', 'esc edit', 10), ('settle', 0.5),
            ('keys', '\x1b'), ('wait_for', '› also run the linter', 10), ('settle', 0.5), ('snap', 'taken-back'),
            ('keys', '\r'), ('wait_for', 'sending at the next pause', 10), ('snap', 'resent'),
            ('wait_for', 'The build passed.', 40), ('settle', 3),
        ],
        'watch': ['start the build', 'The build passed.'],
        'snap_once': {'resent': ['› also run the linter']},
        'final_once': ['› also run the linter'],
    },
    # The same, in a queue (`/send queue`): taken back, edited, sent again.
    'esc-then-resubmit-queue': {
        'cols': 80, 'env': {'FAKE_STEERING': '1', 'FAKE_DELAY_MS': '150'},
        'turns': [{'intro': 'Starting the long build.', 'hold_ms': 5000, 'blocks': ['The build passed.']},
                  {'blocks': ['Queued turn answered.']}],
        'steps': [
            ('type', '/send queue'), ('settle', 2),
            ('type', 'start the build'), ('wait_for', 'Starting the long build.', 30),
            ('type', 'also run the linter'), ('wait_for', 'queued for next turn', 10), ('settle', 0.5),
            ('keys', '\x1b'), ('wait_for', '› also run the linter', 10), ('settle', 0.5),
            ('keys', ' please'), ('keys', '\r'), ('wait_for', 'queued for next turn', 10), ('snap', 'resent'),
            ('wait_for', 'Queued turn answered.', 60), ('settle', 3),
        ],
        'watch': ['start the build', 'Queued turn answered.'],
        'snap_once': {'resent': ['also run the linter please']},
        'final_once': ['also run the linter please'],
    },
    # Two messages typed one after the other while a call runs: each is one
    # row, in the order typed, and each reaches the agent.
    'two-steers-in-a-row': {
        'env': {'FAKE_STEERING': '1', 'FAKE_DELAY_MS': '150'},
        'turns': [{'intro': 'Starting the long build.', 'hold_ms': 6000, 'blocks': ['The build passed.']},
                  {'blocks': ['Queued turn answered.']}],
        'steps': [
            ('type', 'start the build'), ('wait_for', 'sleep 30', 30),
            ('type', 'first extra thing'), ('wait_for', 'sending at the next pause', 10),
            ('type', 'second extra thing'), ('settle', 1),
            ('wait_for', 'The build passed.', 40), ('settle', 4),
        ],
        'watch': ['start the build', 'The build passed.'],
        'dup_ok': ['Steered in:'],
        'final_once': ['› first extra thing', '› second extra thing'],
        'final_in_order': ['› first extra thing', '› second extra thing'],
    },
    # Enter again puts the waiting message in the chat at the FIRST Enter,
    # and it is drawn once.
    'enter-again-first-press': {
        'env': {'FAKE_STEERING': '1', 'FAKE_DELAY_MS': '300'},
        'turns': [{'blocks': ['Step one of the long job.', 'Step two of the long job.', 'The long job is finished.']},
                  {'blocks': ['The queued one answered now.']}],
        'steps': [
            ('type', '/send queue'), ('settle', 2),
            ('type', 'start the long job'), ('wait_for', 'Step one of', 30),
            ('type', 'then do this'), ('wait_for', 'enter again send into the chat', 10),
            ('keys', '\r'), ('wait_for', 'Steered in: then do this.', 20), ('settle', 3),
        ],
        'watch': ['start the long job'],
        'final_once': ['› then do this'],
    },
    # An agent that takes no steering: two messages typed during the turn are
    # two queued rows, run one after the other, each drawn once.
    'two-queued-no-steering': {
        'env': {'FAKE_DELAY_MS': '150'},
        'turns': [{'intro': 'Starting the long build.', 'hold_ms': 3000, 'blocks': ['The build passed.']},
                  {'blocks': ['First queued answered.']}, {'blocks': ['Second queued answered.']}],
        'steps': [
            ('type', 'start the build'), ('wait_for', 'Starting the long build.', 30),
            ('type', 'queued message one'), ('wait_for', 'queued', 10),
            ('type', 'queued message two'), ('settle', 0.5),
            ('wait_for', 'First queued answered.', 60), ('wait_for', 'Second queued answered.', 60), ('settle', 3),
        ],
        'watch': ['start the build'],
        'dup_ok': ['↳ queued for next turn'],
        'final_once': ['› queued message one', '› queued message two'],
        'final_in_order': ['› queued message one', 'First queued answered.', '› queued message two', 'Second queued answered.'],
    },
    # The default is steer, and an agent that takes none (the fake without
    # FAKE_STEERING: Grok's ACP advertises no steering) cannot be steered: the
    # message queues for the next turn and the row says why, instead of
    # looking like the user's own choice of /send queue.
    'unsteerable-queues-and-says-so': {
        'env': {'FAKE_DELAY_MS': '150'},
        'turns': [{'intro': 'Starting the long build.', 'hold_ms': 3000, 'blocks': ['The build passed.']},
                  {'blocks': ['Queued turn answered.']}],
        'steps': [
            ('type', 'start the build'), ('wait_for', 'Starting the long build.', 30),
            ('type', 'also run the linter'), ('wait_for', "this turn can't take it", 10),
            ('wait_for', 'The build passed.', 60), ('wait_for', 'Queued turn answered.', 60), ('settle', 3),
        ],
        'watch': ['start the build', 'also run the linter'],
        'dup_ok': ['↳ queued for next turn'],
        'never': ['sent into the turn', 'sending at the next pause', 'Request interrupted', 'stopping'],
        'final_in_order': ['› start the build', 'The build passed.', '› also run the linter', 'Queued turn answered.'],
    },
    # A message sent into a turn that ends in the same moment: one row, one run.
    'steer-as-turn-ends': {
        'env': {'FAKE_STEERING': '1', 'FAKE_DELAY_MS': '100'},
        'turns': [{'blocks': ['Step one of the job.', 'The job is finished.']}, {'blocks': ['Late one answered.']}],
        'steps': [
            ('type', 'start the job'), ('wait_for', 'The job is finished.', 30),
            ('type', 'late message'), ('wait_for', 'Late one answered.', 30), ('settle', 3),
        ],
        'watch': ['start the job'],
        'final_once': ['› late message'],
    },
    # Taken back twice and sent: only the last send is a message, drawn once.
    'esc-resubmit-twice': {
        'env': {'FAKE_STEERING': '1', 'FAKE_DELAY_MS': '150'},
        'turns': [{'intro': 'Starting the long build.', 'hold_ms': 7000, 'blocks': ['The build passed.']},
                  {'blocks': ['Queued turn answered.']}],
        'steps': [
            ('type', 'start the build'), ('wait_for', 'sleep 30', 30),
            ('type', 'also run the linter'), ('wait_for', 'esc edit', 10), ('settle', 0.5),
            ('keys', '\x1b'), ('wait_for', '› also run the linter', 10), ('settle', 0.5),
            ('keys', '\r'), ('wait_for', 'esc edit', 10), ('settle', 0.5),
            ('keys', '\x1b'), ('wait_for', '› also run the linter', 10), ('settle', 0.5),
            ('keys', '\r'), ('wait_for', 'esc edit', 10), ('snap', 'sent'),
            ('wait_for', 'The build passed.', 40), ('settle', 3),
        ],
        'watch': ['start the build', 'The build passed.'],
        'snap_once': {'sent': ['› also run the linter']},
        'final_once': ['› also run the linter'],
        'never': ['Queued turn answered.'],
        'dup_ok': ['Steered in:'],
    },
    # Taken back and the turn ends before it is sent: the text is in the
    # composer, and Enter sends it as the next message, drawn once.
    'esc-then-turn-ends-then-enter': {
        'env': {'FAKE_STEERING': '1', 'FAKE_DELAY_MS': '150'},
        'turns': [{'intro': 'Starting the long build.', 'hold_ms': 2500, 'blocks': ['The build passed.']},
                  {'blocks': ['Queued turn answered.']}],
        'steps': [
            ('type', 'start the build'), ('wait_for', 'sleep 30', 30),
            ('type', 'also run the linter'), ('wait_for', 'esc edit', 10), ('settle', 0.3),
            ('keys', '\x1b'), ('wait_for', '› also run the linter', 10),
            ('wait_for', 'The build passed.', 40), ('settle', 1), ('keys', '\r'),
            ('wait_for', 'Queued turn answered.', 30), ('settle', 3),
        ],
        'watch': ['start the build'],
        'final_once': ['› also run the linter', 'Queued turn answered.'],
        'never': ['Steered in:'],
    },
    # Ctrl+C stops a turn, at any point.
    'ctrl-c-stops-turn': {
        'env': {'FAKE_DELAY_MS': '300'},
        'turns': [{'blocks': ['Step one of the long job.', 'Step two of the long job.', 'The long job is finished.']}],
        'steps': [
            ('type', 'start the long job'), ('wait_for', 'Step one of', 30),
            ('keys', '\x03'), ('wait_for', 'Stopped', 15), ('settle', 2),
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
            ('keys', '\x1b'), ('wait_for', 'Stopped', 15), ('settle', 2),
        ],
        'snap_contains': {'running': ['writing · ', ' · esc stop']},
        'watch': ['start the long job', 'Step one of'],
        'never': ['The long job is finished.', 'Worked for'],
        'final_contains': ['Stopped'],
    },
    # A turn stopped under a running call reads as stopped, not finished:
    # the call's row says stopped, the turn ends on "Stopped", and the
    # saved turn -- reopened by a fresh process -- says the same.
    'stopped-turn-reads-stopped': {
        'cols': 70, 'env': {'FAKE_DELAY_MS': '60'},
        'turns': [{'intro': 'Starting the long build.', 'hold_ms': 20000, 'blocks': ['The build passed.']}],
        'steps': [
            ('type', 'start the build'), ('wait_for', 'sleep 30', 30), ('settle', 1),
            ('keys', '\x03'), ('wait_for', 'Stopped', 15), ('settle', 2), ('snap', 'stopped'),
            ('restart',), ('keys', '\x1b[D'), ('settle', 2), ('keys', '\r'), ('settle', 2.5),
        ],
        'watch': [],
        'snap_contains': {'stopped': ['■ $ sleep 30 stopped', 'Stopped']},
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
            ('type', '/send queue'), ('settle', 2),
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
        'snap_contains': {'board-and-back': ['Running the parts first.', 'Then the commit was checked.']},
        'final_contains': ['Running the parts first.', 'Then the commit was checked.'],
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
        'snap_contains': {'rejoined': ['Running the parts first.']},
        'final_contains': ['Running the parts first.', 'Then the commit was checked.'],
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
        # Thirty paragraphs, one per part, then a call that stays open: a run of calls is now one
        # row, so the long transcript the scroll needs is made of the answer's own rows.
        'turns': [{'emits': [*[{'op': 'text', 'text': f'run part{n} done.\n\n', 'ms': 5} for n in range(1, 31)],
                             {'op': 'tool', 'id': 'hold', 'title': 'sleep 30', 'ms': 25000}]}],
        'steps': [
            ('type', 'run every part'), ('wait_for', 'sleep 30', 40), ('settle', 1.5), ('snap', 'before'),
            *[step for _ in range(5) for step in (('keys', '\x1b[<64;35;20M'), ('settle', 0.4))], ('settle', 1), ('snap', 'scrolled'),
            ('keys', '\x1b'), ('settle', 1.5), ('snap', 'back'),
        ],
        'watch': [], 'scroll_moves': {'pattern': r'run part(\d+)'},
        'never': ['Interrupted turn activity'],
    },
    # Reading back through a turn that is still working is a scroll and nothing else:
    # no frame addresses a row below the screen, the composer is whole in every frame,
    # and each step is handed to the terminal as a shift (a few rows drawn), not the
    # whole history rewritten. The first step used to write one row too many -- the
    # live tail's slice ended at a negative index -- so the footer landed on the
    # composer's bottom rule, and rewrote every row besides.
    'scroll-into-history-while-working-is-stable': {
        'cols': 70, 'rows': 40, 'env': {'FAKE_TOOL_MS': '150', 'FAKE_DELAY_MS': '40'},
        'turns': [{'emits': [*[{'op': 'text', 'text': f'run part{n} done.\n\n', 'ms': 5} for n in range(1, 31)],
                             {'op': 'tool', 'id': 'hold', 'title': 'sleep 30', 'ms': 25000}]}],
        'steps': [
            ('type', 'run every part'), ('wait_for', 'sleep 30', 40), ('settle', 1.5), ('snap', 'before'), ('mark',),
            *[step for _ in range(5) for step in (('keys', '\x1b[<64;35;20M'), ('settle', 0.4))], ('settle', 1), ('snap', 'scrolled'),
            ('keys', '\x1b'), ('settle', 1.5), ('snap', 'back'), ('mark_end',),
        ],
        'watch': [], 'scroll_moves': {'pattern': r'run part(\d+)'},
        # Coming back from 15 rows up shows about 13 rows that were not on screen; a rewrite is 34 or more.
        'rows_within_screen': True, 'composer_whole_after_mark': True, 'cheap_frames_after_mark': 20,
        'never': ['Interrupted turn activity'],
    },
    # A phone with its keyboard up sends a swipe as arrow keys only: Up with
    # nothing typed must scroll a running turn back, as it does at the prompt.
    # Recorded: during a long turn the keyboard came up and every swipe after
    # that did nothing.
    'long-turn-swipe-arrows-scroll': {
        'cols': 70, 'rows': 32, 'env': {'FAKE_TOOL_MS': '150', 'FAKE_DELAY_MS': '40'},
        'turns': [{'emits': [*[{'op': 'text', 'text': f'run part{n} done.\n\n', 'ms': 5} for n in range(1, 31)],
                             {'op': 'tool', 'id': 'hold', 'title': 'sleep 30', 'ms': 25000}]}],
        'steps': [
            ('type', 'run every part'), ('wait_for', 'sleep 30', 40), ('settle', 1.5), ('snap', 'before'), ('mark',),
            *[step for _ in range(4) for step in (('keys', '\x1b[A'), ('settle', 0.4))], ('settle', 1), ('snap', 'scrolled'),
            ('keys', '\x1b'), ('settle', 1.5), ('snap', 'back'), ('mark_end',),
        ],
        'watch': [], 'scroll_moves': {'pattern': r'run part(\d+)'},
        # Each step is a shift of the history, not the history drawn again. Back at the live edge from
        # 12 rows up shows 12 rows that were not on screen, and the live block; a rewrite is 28 or more.
        'rows_within_screen': True, 'composer_whole_after_mark': True, 'cheap_frames_after_mark': 18,
        'never': ['Interrupted turn activity'],
    },
    # The same in a window that joined the running turn (out to the board and
    # back), where the whole turn so far arrives at once.
    'joined-turn-scroll-moves-whole-screen': {
        'cols': 70, 'rows': 40, 'env': {'FAKE_TOOL_MS': '150', 'FAKE_DELAY_MS': '40'},
        # Thirty paragraphs and a call that stays open (a run of calls is one row, so the long
        # transcript is the answer's own rows, as in the two scenarios above).
        'turns': [{'emits': [*[{'op': 'text', 'text': f'run part{n} done.\n\n', 'ms': 5} for n in range(1, 31)],
                             {'op': 'tool', 'id': 'hold', 'title': 'sleep 30', 'ms': 25000}]}],
        'steps': [
            ('type', 'run every part'), ('wait_for', 'sleep 30', 40), ('settle', 1),
            ('keys', '\x1b[D'), ('settle', 1.5), ('keys', '\r'), ('settle', 2.5), ('snap', 'before'),
            *[step for _ in range(5) for step in (('keys', '\x1b[<64;35;20M'), ('settle', 0.4))], ('settle', 1), ('snap', 'scrolled'),
            ('keys', '\x1b'), ('settle', 1.5), ('snap', 'back'),
        ],
        'watch': [], 'scroll_moves': {'pattern': r'run part(\d+)'},
        'never': ['Interrupted turn activity'],
    },
    # Out of usage on the only account: the Resume-in picker offers to wait
    # for the reset; chosen, the status line says so until Esc stops it.
    'wait-for-reset': {
        'turns': [{'refuse': 'The monthly usage limit has been reached. Try again in 2 hours.', 'blocks': ['unused']}],
        'steps': [
            ('type', 'please check the commit'), ('wait_for', 'Wait for reset (', 30), ('settle', 1),
            ('keys', '\r'), ('wait_for', 'waiting for reset ·', 15), ('settle', 1), ('snap', 'waiting'),
            ('keys', '\x1b'), ('settle', 4), ('mark',), ('settle', 16),
        ],
        # Stopped: neither the status line nor a redraw brings it back.
        'never_after_mark': ['waiting for reset ·'],
        'watch': [],
        'ever': ['All accounts exhausted · back'],
        'snap_contains': {'waiting': ['waiting for reset ·']},
        'never': ['Stopped waiting for the reset'],
    },
    # Typing in the palette highlights the best match: `/c` and `/co` used
    # to highlight /account (its group came first) over /compact and /copy.
    'palette-best-match-first': {
        'turns': [TWO_BLOCKS],
        'steps': [('keys', '/c'), ('settle', 1), ('snap', 'c'), ('keys', 'o'), ('settle', 1), ('snap', 'co')],
        'watch': [], 'snap_contains': {'c': ['❯ /c'], 'co': ['❯ /co']}, 'snap_lacks': {'c': ['❯ /account'], 'co': ['❯ /account']},
    },
    # A provider list covers the chat above the composer. The composer, the
    # info line and the chat above the list stay on their rows, and closing
    # the list does not blank the screen while the choice is applied.
    'provider-list-keeps-the-composer': {
        'cols': 80, 'rows': 36,
        'turns': [{'blocks': ['Hello there, all good.']}],
        'steps': [
            ('type', 'check the ledger'), ('wait_for', 'Hello there, all good.', 40), ('settle', 4), ('snap', 'closed'),
            ('type', '/provider'), ('wait_for', 'Choose a provider', 25), ('settle', 0.6), ('snap', 'open'),
            ('keys', '\x1b'), ('settle', 1.2), ('snap', 'back'),
        ],
        'watch': [],
        'snap_same_row': [
            ('open', 'Grok Build  •'), ('back', 'Grok Build  •'),
            ('back', 'Hello there, all good.'),
        ],
        'snap_contains': {'open': ['\n  › ', 'Choose a provider'], 'closed': ['\n  › ', 'Hello there, all good.'], 'back': ['\n  › ']},
        'snap_lacks': {'back': ['Choose a provider']},
    },
    # The footer is one height from before a turn to after it. The composer
    # stays on its row when the turn starts, a thought appears and goes, text
    # arrives, a background terminal comes and goes, and the turn ends; the
    # chat row above does not hop while a thought or the terminals' count
    # comes and goes.
    'footer-steady-through-turn': {
        'cols': 80, 'rows': 36,
        'turns': [{'blocks': ['Hello there, all good.']}, {'emits': [
            {'op': 'sleep', 'ms': 1500},
            {'op': 'thought', 'heading': 'Weighing', 'text': 'Reading the config to see where the retry lives.'},
            {'op': 'sleep', 'ms': 3000},
            {'op': 'text', 'text': 'Second answer streams in.\n\n'},
            {'op': 'background', 'tasks': [{'type': 'local_bash', 'description': 'npm run dev'}]},
            {'op': 'sleep', 'ms': 3000},
            {'op': 'background', 'tasks': []},
            {'op': 'sleep', 'ms': 3000}]}],
        'steps': [
            ('type', 'check the ledger'), ('wait_for', 'Hello there, all good.', 40), ('settle', 1.5), ('snap', 'closed'),
            ('type', 'and again'), ('settle', 0.8), ('snap', 'started'),
            ('wait_for', 'Reading the config', 20), ('settle', 0.4), ('snap', 'thought'),
            ('wait_for', 'Second answer streams in.', 20), ('settle', 0.5), ('snap', 'text'),
            ('wait_for', '1 background terminal running', 20), ('settle', 0.5), ('snap', 'terminal'),
            ('settle', 3.2), ('snap', 'terminal-gone'),
            ('wait_for', 'Worked for', 30), ('settle', 1.5), ('snap', 'ended'),
        ],
        'watch': [],
        'snap_composer_same': ['started', 'thought', 'text', 'terminal', 'terminal-gone', 'ended'],
        'snap_pair_same_row': [('started', 'thought', 'and again'), ('text', 'terminal', 'Second answer streams in.'), ('terminal', 'terminal-gone', 'Second answer streams in.')],
        'snap_contains': {'thought': ['Reading the config'], 'terminal': ['1 background terminal running']},
        'snap_lacks': {'text': ['Reading the config'], 'terminal-gone': ['background terminal']},
    },
    # A notice appears over the chat and expires without the composer or the chat moving.
    'notice-keeps-the-composer': {
        'cols': 80, 'rows': 36,
        'turns': [{'blocks': ['Hello there, all good.']}],
        'steps': [
            ('type', 'check the ledger'), ('wait_for', 'Hello there, all good.', 40), ('settle', 1.5), ('snap', 'closed'),
            ('keys', '\x03'), ('wait_for', 'Press Ctrl+C again to exit', 10), ('settle', 0.3), ('snap', 'notice'),
            ('settle', 2.6), ('snap', 'expired'),
        ],
        'watch': [],
        'snap_composer_same': ['notice', 'expired'],
        'snap_same_row': [('notice', 'Grok Build  •'), ('expired', 'Grok Build  •'), ('notice', 'Hello there, all good.'), ('expired', 'Hello there, all good.')],
        'snap_contains': {'notice': ['Press Ctrl+C again to exit']},
        'snap_lacks': {'expired': ['Press Ctrl+C again to exit']},
    },
    # Typing while a turn animates does not blink the caret.
    'caret-steady-while-animating': {
        'cols': 80, 'rows': 36,
        'turns': [{'emits': [{'op': 'text', 'text': 'Working through it.\n\n'}, {'op': 'sleep', 'ms': 5000}, {'op': 'text', 'text': 'Done now.'}]}],
        'steps': [
            ('type', 'start the long one'), ('wait_for', 'Working through it.', 30), ('settle', 0.8),
            ('keys', 'ab'), ('settle', 0.2), ('cursor_quiet', 2.0), ('keys', 'cd'), ('cursor_quiet', 0.8),
            ('wait_for', 'Done now.', 20), ('settle', 1),
        ],
        'watch': [],
    },
    # A key typed in the middle of a resize burst echoes at once; the burst clears the screen once.
    'resize-burst-echoes-keys': {
        'cols': 70, 'rows': 40,
        'turns': [{'blocks': ['Hello there, all good.']}],
        'steps': [
            ('type', 'check the ledger'), ('wait_for', 'Hello there, all good.', 40), ('settle', 1.5),
            ('resize_burst_typing', 'Z'), ('settle', 0.5),
        ],
        'watch': [], 'final_contains': ['Hello there, all good.'],
    },
    # Effort moved to High in its row, then Tab → "Make default for every
    # harness": the value saved is the one shown (it saved the value Settings
    # opened with), and Settings stays open on the row (it closed).
    'settings-default-saves-shown-value': {
        'turns': [TWO_BLOCKS],
        # Effort is the fifth row (Resume is first); Enter opens its picker, and the value shown after
        # choosing High is the value "Make default for every harness" must save.
        'steps': [('keys', '/settings'), ('settle', 1), ('keys', '\r'), ('wait_for', 'Account', 10), ('settle', 0.5),
                  *[step for _ in range(4) for step in (('keys', '\x1b[B'), ('settle', 0.3))],
                  ('keys', '\r'), ('wait_for', 'Reasoning effort', 10), ('settle', 0.5),
                  ('keys', '\x1b[B'), ('settle', 0.3), ('keys', '\r'), ('settle', 1),
                  ('keys', '\t'), ('wait_for', 'Make default for every harness', 10), ('settle', 0.5),
                  ('keys', '\x1b[B'), ('settle', 0.3), ('keys', '\r'), ('settle', 2.5), ('snap', 'after'),
                  ('keys', '\x1b'), ('settle', 1)],
        'watch': [], 'never': ['Default saved', 'for every harness: medium'],
        'snap_contains': {'after': ['❯ Effort  High']},
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
    # What a command answers is one line, cut to the width, at 70 columns
    # too: /export's result and /model's error.
    'notices-wrap-at-70-cols': {
        'cols': 70,
        'turns': [{'blocks': ['Hello there, all good.']}],
        'steps': [('type', 'hi'), ('wait_for', 'Hello there, all good.', 30), ('settle', 2),
                  ('type', '/export'), ('wait_for', 'Transcript written', 10), ('settle', 1), ('snap', 'export'),
                  ('type', '/model nosuch-model'), ('settle', 3), ('snap', 'model')],
        'watch': [], 'snap_contains': {'export': ['Transcript written'], 'model': ['is not a model Grok Build publishes']},
    },
    # ← in /account is back, as in every other list: to the Settings row it
    # was opened from, or closed. It reopened the palette with "/", and Esc
    # from Settings then left the palette open.
    'account-back-returns-to-settings': {
        'turns': [TWO_BLOCKS],
        'steps': [('type', 'hi'), ('wait_for', 'The final commit is live.', 40), ('settle', 1),
                  ('keys', '/settings'), ('settle', 1), ('keys', '\r'), ('wait_for', 'Account', 10), ('settle', 0.5),
                  *[step for _ in range(3) for step in (('keys', '\x1b[B'), ('settle', 0.3))],
                  ('keys', '\r'), ('wait_for', 'Grok Build accounts', 10), ('settle', 1),
                  ('keys', '\x1b[D'), ('settle', 1.5), ('snap', 'settings'), ('keys', '\x1b'), ('settle', 1.5), ('snap', 'closed'),
                  ('type', '/account'), ('wait_for', 'Grok Build accounts', 10), ('settle', 1), ('keys', '\x1b[D'), ('settle', 1.5), ('snap', 'direct')],
        'watch': [], 'snap_contains': {'settings': ['❯ Account']},
        'snap_lacks': {'closed': ['› /', '/settings'], 'direct': ['› /', 'Grok Build accounts']},
    },
    # At 70 columns the row in force still says "current" (a long
    # description used to push it off), and the hint keeps "esc close"
    # (it dropped before the "N total" count).
    'current-and-esc-at-70-cols': {
        'cols': 70,
        'turns': [TWO_BLOCKS],
        'steps': [('type', '/permissions'), ('wait_for', 'Choose permissions', 10), ('settle', 1), ('snap', 'permissions'),
                  ('keys', '\x1b'), ('settle', 1),
                  ('type', '/send'), ('wait_for', 'Messages typed mid-turn', 10), ('settle', 1), ('snap', 'send'), ('keys', '\x1b'), ('settle', 1)],
        'watch': [], 'snap_contains': {'permissions': ['· current', 'esc close'], 'send': ['· current', 'esc close']},
    },
    # /usage with a vendor that reports no token counts: no bare zeros
    # ("0", "0 in · 0 out", "This chat · 1 turn · 0").
    'usage-no-bare-zeros': {
        'turns': [{'blocks': ['Hello there, all good.']}],
        'steps': [('type', 'hi'), ('wait_for', 'Hello there, all good.', 30), ('settle', 2),
                  ('type', '/usage'), ('wait_for', 'This chat', 10), ('settle', 1), ('snap', 'usage')],
        'watch': [], 'snap_contains': {'usage': ['This chat · 1 turn']},
        'snap_lacks': {'usage': ['0 in', '0 out', '1 turn · 0', '\n  0 \n', '  0   ']},
    },
    # Fast work shows no spinner: "checking harnesses" (/doctor) and a quick
    # `!true` flashed their band (and a blank frame) for a few milliseconds.
    # The `!` line is drawn at once, before its output.
    'no-spinner-flash-on-fast-work': {
        'turns': [TWO_BLOCKS],
        'steps': [('type', '/doctor'), ('settle', 2), ('keys', '\x1b'), ('settle', 1),
                  ('type', '!true'), ('settle', 2)],
        'watch': [], 'never': ['checking harnesses', '! true ·'], 'final_contains': ['!true', 'exit 0'],
    },
    # Commands that did something say nothing of it: /copy puts the answer on
    # the clipboard (OSC 52 over SSH) and /logout signs out.
    'commands-say-what-they-did': {
        'turns': [TWO_BLOCKS],
        'steps': [('type', 'please check the commit'), ('wait_for', 'The final commit is live.', 40), ('settle', 1),
                  ('type', '/copy'), ('settle', 2),
                  ('type', '/logout'), ('settle', 3)],
        'watch': [], 'never': ['Copied', 'Signed out of'], 'clipboard': 'Checking the workspace first.\n\nThe final commit is live.',
    },
    # Out of usage on one of two accounts: the turn switches to the other on
    # its own, a line in the conversation says so and stays (it was on screen
    # for a moment and never saved).
    'failover-switch-is-said-and-kept': {
        'turns': [{'blocks': ['First answer on the first account.']},
                  {'refuse': 'The monthly usage limit has been reached. Try again in 2 hours.', 'blocks': ['unused']},
                  {'blocks': ['Answered on the other account.']}],
        'steps': [('type', 'hello'), ('wait_for', 'First answer on the first account.', 40), ('settle', 1),
                  ('keys', '/account'), ('settle', 1), ('keys', '\r'), ('wait_for', 'Grok Build accounts', 10), ('settle', 2),
                  ('keys', '\x1b[B'), ('settle', 0.5), ('keys', '\r'), ('settle', 6),
                  ('type', 'carry on'), ('wait_for', 'Answered on the other account.', 40), ('settle', 2), ('snap', 'after'),
                  ('restart',), ('keys', '\x1b[D'), ('settle', 2), ('keys', '\x1b[B'), ('settle', 0.5), ('keys', '\r'),
                  ('wait_for', 'Answered on the other account.', 10), ('settle', 2)],
        'watch': [], 'snap_contains': {'after': ['Switched to ', 'is out of usage']},
        'final_contains': ['Switched to ', 'is out of usage'], 'never': ['usage exhausted', 'All accounts exhausted'],
    },
    # A background agent the usage limit cuts off (Claude: the agent fails with "You've hit your session
    # limit", then says the sentence itself): with no key pressed, the account is marked out, and the agent
    # is started again on the other account with its own task. Nothing waits on the spent account.
    'agent-cut-off-by-limit-moves-on': {
        'turns': [{'blocks': ['First answer on the first account.']},
                  {'emits': [{'op': 'agent-bg', 'id': 't1', 'task': 'a1', 'description': 'Open B5 games', 'prompt': 'Check the games endpoints'}],
                   'blocks': ['Started the games agent.'],
                   'after': [{'op': 'sleep', 'ms': 1500},
                             {'op': 'task-end', 'id': 't1', 'task': 'a1', 'status': 'failed', 'summary': "Agent terminated early due to an API error: You've hit your session limit · resets 7:50am (America/Denver)"},
                             {'op': 'say', 'ms': 30, 'whole': True, 'text': "You've hit your session limit · resets 7:50am (America/Denver)"}]},
                  {'blocks': ['Restarted here, task {has:Check the games endpoints}.']}],
        'steps': [('type', 'hello'), ('wait_for', 'First answer on the first account.', 40), ('settle', 1),
                  ('keys', '/account'), ('settle', 1), ('keys', '\r'), ('wait_for', 'Grok Build accounts', 10), ('settle', 2),
                  ('keys', '\x1b[B'), ('settle', 0.5), ('keys', '\r'), ('settle', 6),
                  ('type', 'start the games agent'), ('wait_for', 'Started the games agent.', 40),
                  ('wait_for', 'Restarted here, task', 60), ('settle', 2), ('snap', 'after')],
        'watch': [], 'snap_contains': {'after': ['Restarted here, task carried.']},
        'never': ['waiting for running work', "You've hit your session limit", 'All accounts exhausted'],
    },
    # A background command still running when the conversation moves to another account: the next turn
    # starts at once (nothing waits on the old account), the command runs on, and its output goes to the
    # account the conversation is on when it ends.
    'background-command-follows-the-switch': {
        'turns': [{'emits': [{'op': 'spawn-bg', 'cmd': 'sleep 25; echo all checks passed'}], 'blocks': ['Started the checks in the background.']},
                  {'blocks': ['Carried on on the other account.']},
                  {'blocks': ['The checks result: {has:all checks passed}.']}],
        'steps': [('type', 'start the checks'), ('wait_for', 'Started the checks in the background.', 40), ('settle', 1),
                  ('keys', '/account'), ('settle', 1), ('keys', '\r'), ('wait_for', 'Grok Build accounts', 10), ('settle', 2),
                  ('keys', '\x1b[B'), ('settle', 0.5), ('keys', '\r'), ('settle', 3),
                  ('type', 'carry on'), ('wait_for', 'Carried on on the other account.', 15),
                  ('wait_for', 'The checks result:', 60), ('settle', 2), ('snap', 'after')],
        'watch': [], 'snap_contains': {'after': ['The checks result: carried.']},
        'never': ['waiting for running work', '[background command'],
    },
    # A turn the vendor refuses as signed out signs in mid-turn and is
    # answered, and says nothing of the sign-in.
    'mid-turn-sign-in-is-said': {
        'turns': [{'blocks': ['First answer.']},
                  {'refuse': 'Authentication required: not logged in. Run grok login. (401 Unauthorized)', 'blocks': ['unused']},
                  {'blocks': ['Answered after signing in again.']}],
        'steps': [('type', 'hello'), ('wait_for', 'First answer.', 40), ('settle', 1), ('mark',),
                  ('type', 'carry on'), ('wait_for', 'Answered after signing in again.', 40), ('settle', 3)],
        'watch': [], 'ever_after_mark': ['waiting for you to sign in'], 'final_once': ['› carry on'],
        'final_contains': ['Answered after signing in again.'],
        'never': ['signed in to Grok Build'],
    },
    # A provider never signed in is "not signed in" in /account, with signing
    # in as what Enter does -- not "reauth" with "del remove" from launch.
    'never-signed-in-account-row': {
        'turns': [TWO_BLOCKS],
        'steps': [('keys', '/account'), ('settle', 1), ('keys', '\r'), ('wait_for', 'Grok Build accounts', 10), ('settle', 2), ('snap', 'list'),
                  ('keys', '\r'), ('settle', 6)],
        'watch': [], 'snap_contains': {'list': ['not signed in']}, 'snap_lacks': {'list': ['reauth', 'del remove']},
        'never': ['reauth'],
    },
    # A second account with no email to go by is "Grok Build 2", not "Grok
    # Build 1" beside "Grok Build".
    'second-account-numbered-2': {
        'turns': [TWO_BLOCKS],
        'steps': [('type', 'hello'), ('wait_for', 'The final commit is live.', 40), ('settle', 1),
                  ('keys', '/account'), ('settle', 1), ('keys', '\r'), ('wait_for', 'Grok Build accounts', 10), ('settle', 2),
                  ('keys', '\x1b[B'), ('settle', 0.5), ('keys', '\r'), ('settle', 6),
                  ('keys', '/account'), ('settle', 1), ('keys', '\r'), ('wait_for', 'Grok Build accounts', 10), ('settle', 2), ('snap', 'list')],
        'watch': [], 'snap_contains': {'list': ['Grok Build 2']}, 'never': ['Grok Build 1'],
    },
    # /diff outside a git repository says so plainly ("Error: error: unknown
    # option `cached'" before).
    'diff-outside-git': {
        'turns': [TWO_BLOCKS],
        'steps': [('type', '/diff'), ('wait_for', 'Not a git repository', 10), ('settle', 1)],
        'watch': [], 'never': ['Error:', 'unknown option'],
    },
    # /gateway on a conversation with history moves it, as /provider's
    # Gateway row does (it refused: "Use the interactive /provider menu");
    # closing its sign-in choice leaves the conversation where it was.
    # A Gateway chat shows what its calls are paid from in the composer's upper right, where a vendor
    # chat shows its plan window: the balance, or that the account is not metered.
    # The same turn through ClikCode's own agent (the Gateway) and through a native harness draws the same rows.
    'gateway-tool-turn-rows': {
        'turns': [{}], 'harness': 'grok', 'setup': gateway_fake(), 'startup': 5, 'no_dup_check': 'timing',
        'steps': [('keys', '\r'), ('settle', 3), ('type', 'GW-TOOLS GW-HEAD go'), ('wait_for', 'Both reads came back fine.', 40), ('settle', 2),
                  # The two reads are one row; Ctrl+O lists them.
                  ('keys', '\x0f'), ('settle', 1)],
        'watch': [], 'final_contains': ['Thought for', '· Planning', 'Read 2 files', 'Read alpha.txt', 'Read beta.txt', 'Both reads came back fine.'],
        'never': ['Error:'],
    },
    'gateway-transient-5xx-retries': {
        'turns': [{}], 'harness': 'grok', 'setup': gateway_fake(), 'startup': 5, 'no_dup_check': 'timing',
        'steps': [('keys', '\r'), ('settle', 3), ('type', 'GW-5XX go'), ('wait_for', 'Starting the work now.', 40), ('settle', 2)],
        'watch': [], 'final_contains': ['Starting the work now.'], 'never': ['upstream unavailable', 'Error:'],
    },
    'gateway-esc-stops-the-turn': {
        'turns': [{}], 'harness': 'grok', 'setup': gateway_fake(), 'startup': 5, 'no_dup_check': 'timing',
        'steps': [('keys', '\r'), ('settle', 3), ('type', 'GW-SLOW go'), ('wait_for', 'word3', 20), ('keys', '\x1b'), ('settle', 3)],
        'watch': [], 'final_contains': ['Stopped'], 'never': ['word49'],
    },
    'gateway-steer-gets-its-own-answer': {
        'turns': [{}], 'harness': 'grok', 'setup': gateway_fake(), 'startup': 5, 'no_dup_check': 'timing',
        'steps': [('keys', '\r'), ('settle', 3), ('type', 'GW-SLOW go'), ('wait_for', 'word3', 20), ('type', 'steer-now please'), ('wait_for', 'Steer received, adjusting.', 30), ('settle', 2)],
        'watch': [], 'final_contains': ['steer-now please', 'Steer received, adjusting.'], 'never': ['Error:'],
    },
    'gateway-credit-on-composer': {
        'turns': [{}], 'harness': 'grok', 'setup': gateway_fake(), 'startup': 5, 'no_dup_check': 'static screen',
        'steps': [('keys', '\r'), ('settle', 4)],
        'watch': [], 'final_contains': ['$12.50 credit left'],
    },
    'gateway-unlimited-on-composer': {
        'turns': [{}], 'harness': 'grok', 'setup': gateway_fake({'GATEWAY_FAKE_UNLIMITED': '1'}), 'startup': 5, 'no_dup_check': 'static screen',
        'steps': [('keys', '\r'), ('settle', 4)],
        'watch': [], 'final_contains': ['Unlimited credit'], 'never': ['credit left'],
    },
    'gateway-moves-existing-conversation': {
        'turns': [{'blocks': ['Hello there, all good.']}],
        'steps': [('type', 'hi'), ('wait_for', 'Hello there, all good.', 30), ('settle', 2),
                  ('type', '/gateway'), ('wait_for', 'Sign in to ClikDeploy Gateway', 10), ('settle', 0.5),
                  ('keys', '\x1b'), ('settle', 2)],
        'watch': [], 'never': ['Use the interactive /provider menu', 'Error:'], 'final_contains': ['Grok Build  •'],
    },
    # Settings' rows stay where they are as the cursor lands on a row chosen
    # in place (they moved two columns right), and its hint names Enter and
    # Tab, which both act there.
    'settings-inline-row-steady': {
        'turns': [TWO_BLOCKS],
        'steps': [('keys', '/settings'), ('settle', 1), ('keys', '\r'), ('wait_for', 'Account', 10), ('settle', 0.5),
                  ('keys', '\x1b[B'), ('settle', 0.5), ('snap', 'plain'),
                  *[step for _ in range(4) for step in (('keys', '\x1b[B'), ('settle', 0.3))], ('settle', 0.5), ('snap', 'inline')],
        'watch': [], 'snap_contains': {'plain': ['\n  Model  grok-4'], 'inline': ['\n  Model  grok-4', 'enter next', 'tab options']},
        'snap_lacks': {'inline': ['\n    Model']},
    },
    # An account name that matches none is said in plain words, not "local
    # AI account ... was not found".
    'unknown-account-plain-words': {
        'turns': [TWO_BLOCKS],
        'steps': [('type', '/account nosuch'), ('wait_for', 'No account named "nosuch"', 10), ('settle', 1)],
        'watch': [], 'never': ['local AI account'],
    },
    # Typing /effort offers "default" with the levels, as the picker does.
    'effort-values-include-default': {
        'turns': [TWO_BLOCKS],
        'steps': [('keys', '/effort '), ('settle', 2), ('snap', 'values'), ('keys', '\x1b'), ('settle', 0.5),
                  ('type', '/effort default'), ('settle', 2)],
        'watch': [], 'snap_contains': {'values': ['❯ default', 'high']}, 'never': ['Error:'],
    },
    # Esc on Resume-in: the message that ran out comes back to the composer,
    # and the notice keeps when usage is back.
    'esc-on-resume-in-gives-message-back': {
        'turns': [{'refuse': 'The monthly usage limit has been reached. Try again in 2 hours.', 'blocks': ['unused']}],
        'steps': [('type', 'please check the commit'), ('wait_for', 'Wait for reset (', 30), ('settle', 1), ('snap', 'picker'),
                  ('keys', '\x1b'), ('settle', 2), ('snap', 'after')],
        'watch': [], 'snap_contains': {'after': ['\n  › please check the commit', 'All accounts exhausted · back ']},
    },
    # A new message sent while a turn waits for the reset replaces the wait,
    # and nothing is said of it.
    'new-message-stops-reset-wait-line-first': {
        'turns': [{'refuse': 'The monthly usage limit has been reached. Try again in 2 hours.', 'blocks': ['unused']},
                  {'blocks': ['Second answer arrives here.']}],
        'steps': [('type', 'please check the commit'), ('wait_for', 'Wait for reset (', 30), ('settle', 1),
                  ('keys', '\r'), ('wait_for', 'waiting for reset ·', 15), ('settle', 1),
                  ('type', 'something else'), ('wait_for', 'Second answer arrives here.', 30), ('settle', 3)],
        'watch': [], 'final_in_order': ['please check the commit', 'something else', 'Second answer arrives here.'], 'never': ['Stopped waiting for the reset'],
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
    # after message 1 holds only that exchange.
    'fork-at-message': {
        'turns': [{'blocks': ['ALPHA answer lives here.']}, {'blocks': ['BETA answer lives here.']}],
        'steps': [
            ('type', 'first question'), ('wait_for', 'ALPHA answer lives here.', 30), ('settle', 2),
            ('type', 'second question'), ('wait_for', 'BETA answer lives here.', 30), ('settle', 2),
            ('type', '/fork'), ('wait_for', 'Fork after which message?', 10), ('settle', 0.5),
            ('keys', '\x1b[B'), ('settle', 0.5), ('keys', '\r'), ('settle', 3), ('mark',), ('settle', 2),
        ],
        'watch': [], 'ever': ['2  second question', '1  first question'],
        'final_contains': ['first question', 'ALPHA answer lives here.'], 'never': ['files on disk are not rewound'],
        'never_after_mark': ['BETA answer lives here.'],
    },
    # /changes lists the turn's edit, /changes 1 shows its diff, /redo @1 with
    # "Put files back" restores the file (the shared undo engine).
    'changes-and-redo': {
        'turns': [{'edits': [{'path': 'notes.txt', 'old': 'alpha\nbeta\n', 'new': 'alpha\nGAMMA\n'}], 'blocks': ['Edited the notes.']}],
        'steps': [
            ('type', 'edit the notes'), ('wait_for', 'Edited the notes.', 30), ('settle', 2),
            ('type', '/changes'), ('wait_for', 'notes.txt · +1 -1', 10), ('settle', 1), ('keys', '\x1b'), ('settle', 1),
            ('type', '/changes 1'), ('wait_for', '+ GAMMA', 10), ('settle', 1), ('keys', '\x1b'), ('settle', 1),
            ('type', '/redo @1'), ('wait_for', 'Put files back as they were', 10), ('settle', 0.5),
            ('keys', '\r'), ('wait_for', 'restored  notes.txt', 10), ('settle', 1),
        ],
        'watch': [], 'ever': ['1  edit the notes', 'Turn 1 · edit the notes', '- beta'],
        'file_contains': {'notes.txt': 'alpha\nbeta\n'},
    },
    # /hindsight: the chat by topic, newest first, numbered by prompt (the N
    # /fork @N and /redo @N take), with the file each topic's turn edited.
    'hindsight-panel': {
        'turns': [{'edits': [{'path': 'notes.txt', 'old': 'alpha\nbeta\n', 'new': 'alpha\nGAMMA\n'}], 'blocks': ['Edited the notes.']},
                  {'blocks': ['Explained the build.']}],
        'steps': [
            ('type', 'edit the notes file'), ('wait_for', 'Edited the notes.', 30), ('settle', 2),
            ('type', 'explain how the build works'), ('wait_for', 'Explained the build.', 30), ('settle', 2),
            ('type', '/hindsight'), ('wait_for', 'Hindsight · 2 topics', 10), ('settle', 1),
        ],
        'watch': [], 'final_contains': ['2  answered', 'explain how the build works', '1  answered', 'notes.txt +1 -1', '/redo @N'],
    },
    # /changes <path> from another conversation: the turns that edited the
    # file, in any conversation; choosing one opens its conversation there.
    'changes-for-path': {
        'turns': [{'edits': [{'path': 'notes.txt', 'old': 'alpha\nbeta\n', 'new': 'alpha\nGAMMA\n'}], 'blocks': ['Edited the notes.']},
                  {'blocks': ['Hello from the second chat.']}],
        'steps': [
            ('type', 'edit the notes'), ('wait_for', 'Edited the notes.', 30), ('settle', 2),
            ('type', '/new'), ('settle', 2),
            ('type', 'say hello'), ('wait_for', 'Hello from the second chat.', 30), ('settle', 2),
            ('type', '/changes notes.txt'), ('wait_for', 'Turns that edited', 10), ('settle', 0.5),
            ('keys', '\r'), ('wait_for', 'turn 1 of 1', 10), ('settle', 1), ('keys', '\x1b'), ('mark',), ('settle', 2),
        ],
        'watch': [], 'ever': ['"edit the notes" · +1 -1'],
        'final_contains': ['edit the notes', 'Edited the notes.'],
        'never_after_mark': ['Hello from the second chat.'],
    },
    # A carried summary shows: a hint on the board's row, and /history opens
    # with it, saying how many turns it covers.
    'summary-shown': {
        'turns': [{'blocks': ['First answer here.']}, {'blocks': ['Second answer here.']}],
        'steps': [
            ('type', 'first question'), ('wait_for', 'First answer here.', 30), ('settle', 2),
            ('type', 'second question'), ('wait_for', 'Second answer here.', 30), ('settle', 2),
            ('set_summary', 1, 'SUMMARY-OF-THE-OPENING asked a first question.'), ('restart', 6),
            ('keys', '\x1b[D'), ('wait_for', 'first 1 turn summarized', 10), ('settle', 1),
            ('keys', '\x1b[B'), ('keys', '\r'), ('wait_for', 'Second answer here.', 10), ('settle', 2),
            ('type', '/history'), ('wait_for', 'SUMMARY-OF-THE-OPENING', 10), ('settle', 1),
        ],
        'watch': [], 'final_contains': ['First 1 turn summarized', 'SUMMARY-OF-THE-OPENING asked a first question.'],
    },
    # `!<command>`: its output is a transcript message, drawn once, with no
    # notice repeating how it exited.
    'shell-line-in-transcript': {
        'turns': [{'blocks': ['Hello there, all good.']}],
        'steps': [('type', 'hi'), ('wait_for', 'Hello there, all good.', 30), ('settle', 2),
                  ('type', '!echo shell-out-$((40+2))'), ('wait_for', 'shell-out-42', 10), ('settle', 2)],
        'watch': ['shell-out-42'], 'final_contains': ['!echo shell-out-$((40+2))', 'exit 0'], 'never': ['rides into the next request'],
    },
    # `!` on an empty composer opens `! ` (typing starts after the space);
    # Backspace with nothing after takes both, and the line is a message again.
    'shell-bang-space': {
        'turns': [{'blocks': ['Hello there, all good.']}],
        'steps': [('keys', '!'), ('settle', 0.4), ('keys', 'x'), ('settle', 0.6), ('snap', 'opened'),
                  ('keys', '\x7f'), ('settle', 0.4), ('keys', '\x7f'), ('settle', 0.6), ('snap', 'cleared'),
                  ('keys', '!'), ('settle', 0.4), ('type', 'echo bang-$((40+2))'), ('wait_for', 'bang-42', 10), ('settle', 1),
                  ('type', 'hi'), ('wait_for', 'Hello there, all good.', 30), ('settle', 1)],
        'watch': ['bang-42'], 'snap_contains': {'opened': ['› ! x']}, 'snap_lacks': {'cleared': ['› !']},
        'final_contains': ['!echo bang-$((40+2))', 'exit 0', 'Hello there, all good.'],
    },

    # ------------------------------------------------------------------
    # Acceptance tests for docs/TURN_FLOW_STANDARD.md, played from an
    # `emits` script (fake-grok.mjs). Several carry `expect_fail`: the
    # stream named is the change that makes them pass; see README.md.
    # ------------------------------------------------------------------
    # 1.4: completion order never decides position. Y finishes first and X
    # (which started first) stays above it, while running and once settled.
    'parallel-order': {
        'turns': [{'emits': [
            {'op': 'text', 'text': 'Running two checks at once.\n\n'},
            {'op': 'tool-start', 'id': 'px', 'title': 'sleep 2'},
            {'op': 'tool-start', 'id': 'py', 'title': 'echo Y'},
            {'op': 'sleep', 'ms': 400},
            {'op': 'tool-end', 'id': 'py', 'result': 'Y'},
            {'op': 'sleep', 'ms': 1800},
            {'op': 'tool-end', 'id': 'px', 'result': 'slept'},
            {'op': 'text', 'text': 'Both checks are done.'}]}],
        # Both calls are one row once they are done; Ctrl+O lists them, still in start order.
        'steps': [('type', 'run both'), ('wait_for', 'Both checks are done.', 40), ('settle', 3), ('keys', '\x0f'), ('settle', 1)],
        'watch': [], 'always_order': [('sleep 2', 'echo Y')],
        'final_in_order': ['Running two checks at once.', 'Ran 2 commands', 'Both checks are done.'],
        'final_contains': ['sleep 2', 'echo Y'],
        'dup_ok': ['Ran 2 commands'],
        'final_once': ['Running two checks at once.', 'Both checks are done.'],
    },
    # 5: a child begun after text the parent wrote is drawn after that text,
    # and two concurrent children each have a slot at once.
    'child-order': {
        'turns': [{'emits': [
            {'op': 'text', 'text': 'Starting the investigation.\n\n'},
            {'op': 'agent-start', 'id': 'ag1', 'title': 'Task: investigate'},
            {'op': 'sleep', 'ms': 400},
            {'op': 'text', 'text': 'Notes written while the agent works.\n\n'},
            {'op': 'child-start', 'id': 'c1', 'parent': 'ag1', 'title': 'Read child-alpha.ts'},
            {'op': 'child-start', 'id': 'c2', 'parent': 'ag1', 'title': 'Read child-bravo.ts'},
            {'op': 'sleep', 'ms': 2500},
            {'op': 'child-end', 'id': 'c1', 'parent': 'ag1'},
            {'op': 'sleep', 'ms': 800},
            {'op': 'child-end', 'id': 'c2', 'parent': 'ag1'},
            {'op': 'agent-end', 'id': 'ag1', 'result': 'investigated'},
            {'op': 'text', 'text': 'The investigation is complete.'}]}],
        'steps': [('type', 'investigate'), ('wait_for', 'The investigation is complete.', 40), ('settle', 3)],
        'watch': [],
        # The agent began before the notes; its children began after them.
        'always_order': [('Agent Task: investigate', 'Notes written while the agent works.'),
                         ('Notes written while the agent works.', 'child-alpha'), ('Notes written while the agent works.', 'child-bravo')],
        'ever_together': [('child-alpha', 'child-bravo')],
        'final_once': ['Notes written while the agent works.', 'The investigation is complete.'],
    },
    # 5a: a sub-agent opens into its own screen from its expanded row (Right), the main turn runs on, Left
    # returns to the main chat, and a harness that gives no way to message it says so in place of the composer.
    # Qwen publishes child frames (read: frames) and no way to send (steer: none), docs/SUBAGENTS.md.
    'subagent-view': {
        'harness': 'qwen', 'setup': signed_in_fake('qwen', '.qwen/settings.json', '{"selectedType": "openai"}'), 'startup': 5,
        'env': {'FAKE_ACP_PROFILE': json.dumps({'modes': {'currentModeId': 'default', 'availableModes': [
            {'id': 'default', 'name': 'Default'}, {'id': 'yolo', 'name': 'Yolo'}, {'id': 'auto', 'name': 'Auto'}]}})},
        'turns': [{'emits': [
            {'op': 'text', 'text': 'Starting the investigation.\n\n'},
            {'op': 'agent-start', 'id': 'ag1', 'title': 'Task: investigate'},
            {'op': 'child-start', 'id': 'c1', 'parent': 'ag1', 'title': 'Read child-alpha.ts'},
            {'op': 'sleep', 'ms': 20000},
            {'op': 'child-end', 'id': 'c1', 'parent': 'ag1'},
            {'op': 'agent-end', 'id': 'ag1', 'result': 'investigated'},
            {'op': 'text', 'text': 'The investigation is complete.'}]}],
        'steps': [('type', 'investigate'), ('wait_for', 'child-alpha', 30), ('settle', 1),
                  ('keys', '\x0f'), ('settle', 1), ('keys', '\x1b[C'), ('wait_for', 'main >', 10), ('settle', 1), ('snap', 'inside'),
                  ('keys', 'hello'), ('settle', 1), ('snap', 'typed'),
                  ('keys', '\x1b[D'), ('settle', 2), ('snap', 'back'),
                  ('wait_for', 'The investigation is complete.', 40), ('settle', 2)],
        'watch': [], 'no_dup_check': 'the view and the main chat both show the row',
        'snap_contains': {'inside': ['main >', 'main: running', 'child-alpha', 'read-only'],
                          'back': ['Starting the investigation.']},
        'snap_lacks': {'inside': ['Starting the investigation.'], 'typed': ['› hello'], 'back': ['main >']},
        'final_contains': ['The investigation is complete.'],
    },
    # 5: a sub-agent that outlasts what the live region can hold is retired
    # as a running line IN ORDER, its held text follows, and nothing is ever
    # drawn above text written before it; the completion is one row where it
    # settled, and the live children sit under a `↳` line meanwhile.
    'agent-release-order': {
        'env': {'FAKE_DELAY_MS': '15'},
        'turns': [{'emits': [
            {'op': 'text', 'text': 'Opening the investigation.\n\n'},
            {'op': 'agent-start', 'id': 'ag2', 'title': 'Task: audit'},
            {'op': 'sleep', 'ms': 300},
            {'op': 'text', 'text': 'Note one while it works.\n\nNote two while it works.\n\nNote three while it works.\n\nNote four while it works.\n\nNote five while it works.\n\nNote six while it works.\n\nNote seven while it works.\n\nNote eight while it works.\n\nNote nine while it works.\n\nNote ten while it works.\n\nNote eleven while it works.\n\nNote twelve while it works.\n\nNote thirteen while it works.\n\nNote fourteen while it works.\n\n'},
            {'op': 'child-start', 'id': 'k1', 'parent': 'ag2', 'title': 'Read audit-one.ts'},
            {'op': 'sleep', 'ms': 1500},
            {'op': 'child-end', 'id': 'k1', 'parent': 'ag2'},
            {'op': 'agent-end', 'id': 'ag2', 'result': 'audited'},
            {'op': 'text', 'text': 'The audit is complete.'}]}],
        'steps': [('type', 'audit it'), ('wait_for', 'The audit is complete.', 40), ('settle', 3)],
        'watch': [],
        'always_order': [('Agent Task: audit', 'Note one while it works.'), ('Note one while it works.', 'Note fourteen while it works.')],
        'final_in_order': ['Opening the investigation.', 'Agent Task: audit', 'Note one while it works.', 'Note fourteen while it works.', 'The audit is complete.'],
        'final_once': ['Note one while it works.', 'Note fourteen while it works.', 'The audit is complete.'],
    },
    # 4/11: each thought settles where it happened -- before the text, and the
    # second after it -- and neither doubles or moves.
    'thought-after-text': {
        'turns': [{'emits': [
            {'op': 'thought', 'heading': 'Planning the approach', 'text': 'Considering which files matter first.'},
            {'op': 'sleep', 'ms': 900},
            {'op': 'text', 'text': 'Here is the first part of the answer.\n\n'},
            {'op': 'thought', 'heading': 'Checking the edge cases', 'text': 'Looking for a boundary that breaks.'},
            {'op': 'sleep', 'ms': 900},
            {'op': 'text', 'text': 'And here is the closing part.'}]}],
        'steps': [('type', 'think it through'), ('wait_for', 'And here is the closing part.', 40), ('settle', 3)],
        'watch': [],
        # Two thoughts of the same length read the same; that is not a double.
        'dup_ok': ['Thought for'],
        'final_in_order': ['Planning the approach', 'Here is the first part of the answer.', 'Checking the edge cases', 'And here is the closing part.'],
        'final_once': ['Planning the approach', 'Checking the edge cases', 'Here is the first part of the answer.'],
    },
    # 8: a declined approval leaves a settled row where it was asked, and the
    # status never goes blank between the question and the next thing.
    'approval-denied-row': {
        'turns': [{'emits': [
            {'op': 'text', 'text': 'About to run a command.\n\n'},
            {'op': 'permission', 'id': 'ap1', 'command': 'rm -rf build'}],
            'blocks': ['It was answered: {answers}.']}],
        'steps': [('type', 'clean it'), ('wait_for', 'Allow once?', 30), ('settle', 1.5), ('keys', 'n'),
                  ('wait_for', 'It was answered: reject.', 20), ('settle', 3)],
        'watch': [],
        'status_always': [('Allow once?', 'It was answered: reject.')],
        'final_in_order': ['About to run a command.', 'rm -rf build', 'It was answered: reject.'],
        # Its own wording (§8), on a transcript row: not the footer's path.
        'final_rows_match': [r'\bdenied\b'], 'final_once': ['rm -rf build'],
    },
    # 3: a table is held in the live region until it closes; no retired row is
    # narrower than a row that came after it.
    'table-stream': {
        'env': {'FAKE_DELAY_MS': '200'},
        'turns': [{'emits': [
            {'op': 'text', 'text': 'Here is the matrix:\n\n| name | role |\n|---|---|\n| a | x |\n| b | y |\n'
                                   '| a-much-longer-name-than-before | a considerably longer role description |\n\nThat is all.'}]}],
        'steps': [('type', 'show the matrix'), ('wait_for', 'That is all.', 40), ('settle', 3)],
        'watch': [], 'table_aligned': True, 'final_once': ['That is all.', 'Here is the matrix:'],
    },
    # 9: `writing` holds for a pause in the middle of an answer.
    'status-writing': {
        'turns': [{'emits': [
            {'op': 'text', 'text': 'This answer begins here and continues,'},
            {'op': 'sleep', 'ms': 3200},
            {'op': 'text', 'text': ' then finishes after a long pause.'}]}],
        'steps': [('type', 'answer slowly'), ('wait_for', 'then finishes after a long pause.', 40), ('settle', 3)],
        'watch': [], 'ever': ['writing'],
        'never_after': [('This answer begins here', 'thinking')],
    },
    # 1.5: a steer acknowledged between two calls: the call begun after it is
    # drawn after it -- with no text between to tell them apart by offset.
    'steer-order': {
        'env': {'FAKE_STEERING': '1'},
        'turns': [{'emits': [
            {'op': 'text', 'text': 'Starting the checks.\n\n'},
            {'op': 'tool', 'id': 'sa', 'title': 'echo alpha', 'ms': 300, 'result': 'alpha'},
            {'op': 'sleep', 'ms': 6000},
            {'op': 'tool', 'id': 'sb', 'title': 'echo bravo', 'ms': 500, 'result': 'bravo'},
            {'op': 'text', 'text': 'All the checks ran.'}]}],
        'steps': [('type', 'start the checks'), ('wait_for', 'echo alpha', 30), ('settle', 1.5),
                  ('type', 'steer this in'), ('wait_for', '› steer this in', 10),
                  ('wait_for', 'All the checks ran.', 40), ('settle', 3)],
        'watch': [], 'ever': ['↳ steered'], 'never': ['sent into the turn', 'Steer received:', 'Delivered to the model:'],
        'always_order': [('echo alpha', '› steer this in'), ('› steer this in', 'echo bravo')],
        'final_in_order': ['echo alpha', '› steer this in', 'echo bravo', 'All the checks ran.'],
        'final_once': ['› steer this in'],
    },
    # A resize while TEXT streams (not only while a call runs): every
    # paragraph is on screen once, the answer carries on after it.
    'mid-turn-resize-while-streaming': {
        'env': {'FAKE_DELAY_MS': '220'},
        'turns': [{'emits': [
            {'op': 'text', 'text': 'First paragraph streams while the terminal narrows and widens again.\n\n'},
            {'op': 'text', 'text': 'Second paragraph follows the resize and must appear once only.\n\n'},
            {'op': 'text', 'text': 'Third ENDMARK paragraph closes it.'}]}],
        'steps': [('type', 'stream it'), ('wait_for', 'First paragraph streams', 30),
                  ('resize', 50, 50), ('settle', 1.5), ('resize', 50, 100),
                  ('wait_for', 'Third ENDMARK paragraph closes it.', 40), ('settle', 3)],
        'watch': [],
        'final_once': ['First paragraph streams', 'Second paragraph follows', 'Third ENDMARK paragraph closes it.'],
    },
    # The vendor's background level carries a shell: one dim row under the
    # status says `1 background terminal running` (singular), `2 ... terminals`
    # (plural) as the level changes, and it is gone when the level empties --
    # while the turn goes on. A terminal is never on the end line.
    'background-terminals-indicator': {
        'turns': [{'emits': [
            {'op': 'text', 'text': 'Starting the dev server.\n\n'},
            {'op': 'background', 'tasks': [{'type': 'local_bash', 'description': 'npm run dev'}]},
            {'op': 'tool', 'id': 'b1', 'title': 'echo first', 'ms': 3500, 'result': 'first'},
            {'op': 'background', 'tasks': [{'type': 'local_bash'}, {'type': 'local_bash'}]},
            {'op': 'tool', 'id': 'b2', 'title': 'echo second', 'ms': 3500, 'result': 'second'},
            {'op': 'background', 'tasks': []},
            {'op': 'tool', 'id': 'b3', 'title': 'echo third', 'ms': 3500, 'result': 'third'},
            {'op': 'text', 'text': 'Everything finished.'}]}],
        'steps': [('type', 'run the server'), ('wait_for', '1 background terminal running', 30), ('settle', 1),
                  ('wait_for', '2 background terminals running', 30), ('settle', 1),
                  ('wait_for', 'echo third', 30), ('settle', 1), ('snap', 'cleared'),
                  ('wait_for', 'Everything finished.', 40), ('settle', 3)],
        'watch': [], 'ever': ['1 background terminal running', '2 background terminals running'],
        'snap_lacks': {'cleared': ['background terminal']},
        'final_contains': ['Everything finished.'], 'never': ['Waiting for'],
    },
    # A terminal the vendor leaves running outlives its turn: the indicator
    # stays (the worker holds the vendor and follows its level), and goes when
    # the shell ends. The turn's own end line does not wait on it.
    'background-terminal-outlives-turn': {
        'turns': [{'emits': [
            {'op': 'text', 'text': 'The dev server is started.'},
            {'op': 'background', 'tasks': [{'type': 'local_bash', 'description': 'npm run dev'}]}],
            'after': [{'op': 'sleep', 'ms': 6000}, {'op': 'background', 'tasks': []}]}],
        'steps': [('type', 'start the server'), ('wait_for', 'The dev server is started.', 30),
                  ('wait_for', '1 background terminal running', 15), ('settle', 1), ('snap', 'running'),
                  ('settle', 9), ('snap', 'gone')],
        'watch': [], 'ever': ['1 background terminal running'], 'never': ['Waiting for'],
        'snap_contains': {'running': ['1 background terminal running'], 'gone': ['The dev server is started.']},
        'snap_lacks': {'gone': ['background terminal']},
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
    # `setup` (the matrix rig, matrix/matrix.py) installs its own fake vendors
    # into fakebin; without it the one fake Grok is installed under `harness`.
    if not spec.get('setup'):
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
    if spec.get('setup'): spec['setup']({'root': root, 'home': home, 'state': state, 'fakebin': fakebin, 'workspace': workspace, 'env': env, 'entry': entry})
    # Never the machine's own Tailscale: the board and /machine ask it which machines the user
    # has. Unless the scenario set one up (remote_fake), this one is not running.
    if not os.path.lexists(os.path.join(fakebin, 'tailscale')):
        os.symlink(os.path.join(REPO, 'scripts', 'tui-e2e', 'fake-tailscale.mjs'), os.path.join(fakebin, 'tailscale'))
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
    bytes_marks = {}
    raw, frames = bytearray(), []
    # When each chunk was read from the pty (time.time(), before it is fed to
    # the emulator), parallel to `frames`: the matrix rig's clock.
    chunk_at = []
    # Whether each frame was taken between synchronized updates (DEC 2026):
    # a frame cut mid-update is a half-drawn screen, not something shown.
    frame_complete = []
    sync = {'open': False}
    # A second window ('open2'): another ClikCode on the same CLIKCODE_HOME,
    # in its own pty and on its own screen, as a second terminal would be.
    pid2, fd2 = None, None
    screen2 = Screen(cols, rows)
    stream2 = ByteStream(screen2)
    raw2, frames2 = bytearray(), []
    # A window whose process has gone (its pty hung up) is not read again.
    closed = {1: False, 2: False}
    start = time.time()
    wall_start = start  # `start` is reused further down

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
                read_at = time.time()
                if not chunk:
                    closed[n] = True
                    continue
                if n == 1:
                    raw.extend(chunk); stream.feed(chunk)
                    begun, ended = chunk.rfind(b'\x1b[?2026h'), chunk.rfind(b'\x1b[?2026l')
                    if begun >= 0 or ended >= 0: sync['open'] = begun > ended
                    frames.append((time.time() - start, '\n'.join(screen.display)))
                    chunk_at.append(read_at)
                    frame_complete.append(not sync['open'])
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
    marked_raw_at = None
    marked_end_at = None
    marked_raw_end_at = None
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
        elif step[0] == 'wait_for_gone':
            gone_by = time.time() + step[2]
            while step[1] in '\n'.join(screen.display) and time.time() < gone_by: pump(0.2)
            if step[1] in '\n'.join(screen.display): problems.append(f'timed out waiting for {step[1]!r} to go')
        elif step[0] == 'settle':
            pump(step[1])
        elif step[0] == 'mark':
            # Where 'never_after_mark' starts looking.
            marked_at = len(frames)
            marked_raw_at = len(raw)
        elif step[0] == 'mark_end':
            # Where the checks that start at the mark stop: what comes after (a turn ending, a restart) is not theirs.
            marked_end_at = len(frames)
            marked_raw_end_at = len(raw)
        elif step[0] == 'snap':
            # The screen as it is now, kept under a name for the checks below.
            snaps[step[1]] = list(screen.display)
            if os.environ.get("SHOW_SNAPS"): print("SNAP", step[1]); print("\n".join(f"  {n:2d}|{l.rstrip()[:100]}" for n, l in enumerate(screen.display) if l.strip()))
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
        elif step[0] == 'set_summary':
            # ('set_summary', through, text): the newest conversation gets a
            # carried summary of its first `through` turns, bound to them the
            # way session/conversation-summary.ts turnsHash binds it.
            index_file = os.path.join(state, 'index.json')
            index = json.load(open(index_file))
            newest = max(index['sessions'], key=lambda item: item.get('updatedAt', ''))
            messages = json.load(open(os.path.join(state, 'sessions', f"{newest['id']}.json"))).get('messages', [])
            turns = []
            for message in messages:
                if message['role'] == 'user': turns.append([message['content'], ''])
                elif turns: turns[-1][1] += message['content'] if message['content'].strip() else ''
            digest = hashlib.sha256()
            for user, assistant in turns[:step[1]]: digest.update(user.encode()); digest.update(b'\0'); digest.update(assistant.strip().encode()); digest.update(b'\x01')
            newest['summary'] = {'text': step[2], 'through': step[1], 'hash': digest.hexdigest()[:32], 'source': 'clikcode', 'at': '2026-10-10T00:00:00.000Z'}
            json.dump(index, open(index_file, 'w'))
        elif step[0] == 'touch_entry':
            os.utime(entry, None)
        elif step[0] == 'remote_rebuild':
            # A newer ClikCode build installed on a fake machine (fake-remote-clikcode.mjs ~/.fake-remote/build).
            open(os.path.join(env['FAKE_SSH_ROOT'], 'hosts', step[1], 'home', '.fake-remote', 'build'), 'w').write(str(time.time()))
            pump(0.3)
        elif step[0] == 'expect_remote_opens':
            # ('expect_remote_opens', host, chat, n, timeout): that chat was opened by n different bridge processes there.
            opens_log = os.path.join(env['FAKE_SSH_ROOT'], 'hosts', step[1], 'home', '.fake-remote', 'opens.log')
            def opened_by():
                try: return {json.loads(line)['pid'] for line in open(opens_log) if line.strip() and json.loads(line)['chat'] == step[2]}
                except OSError: return set()
            deadline = time.time() + (step[4] if len(step) > 4 else 20)
            while len(opened_by()) < step[3] and time.time() < deadline: pump(0.2)
            if len(opened_by()) < step[3]: problems.append(f'chat {step[2]} on {step[1]} was opened by {len(opened_by())} bridge process(es), expected {step[3]}')
        elif step[0] in ('bytes_mark', 'expect_bytes_since'):
            # ('bytes_mark', host): from here, what that fake machine sends back is counted (fake-ssh.mjs countBytes).
            # ('expect_bytes_since', host, most): since the mark it sent at most that many bytes.
            bytes_log = os.path.join(env['FAKE_SSH_ROOT'], 'hosts', step[1], 'bytes.log')
            total = sum(int(line) for line in open(bytes_log) if line.strip()) if os.path.exists(bytes_log) else 0
            if step[0] == 'bytes_mark': bytes_marks[step[1]] = total
            else:
                sent = total - bytes_marks.get(step[1], 0)
                print(f'  {step[1]} sent {sent} bytes since the mark')
                if sent > step[2]: problems.append(f'{step[1]} sent {sent} bytes since the mark, more than {step[2]}')
        elif step[0] == 'expect_file_count':
            # ('expect_file_count', path under the scenario root, text, n): the file holds text exactly n times.
            path = os.path.join(root, step[1])
            found = open(path, errors='replace').read().count(step[2]) if os.path.exists(path) else 0
            if found != step[3]: problems.append(f'{step[1]} holds {step[2]!r} {found} time(s), expected {step[3]}')
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
            clears = raw[before:].count(b'\x1b[2J')
            if os.environ.get('SHOW_SNAPS'): print(f'RESIZE {len(raw) - before} bytes, {clears} clears')
            if clears != 1: problems.append(f'resize burst cleared the screen {clears}x, expected once')
        elif step[0] == 'cursor_quiet':
            # The caret is left alone while frames draw under it (a spinner, a streaming answer): no hide and no show.
            before = len(raw)
            pump(step[1])
            new = bytes(raw[before:])
            hides, shows = new.count(b'\x1b[?25l'), new.count(b'\x1b[?25h')
            frames_seen = new.count(b'\x1b[?2026h')
            if os.environ.get('SHOW_SNAPS'): print(f'CURSOR {frames_seen} frames, {len(new)} bytes, {hides} hides, {shows} shows')
            if frames_seen < 3: problems.append(f'cursor_quiet saw only {frames_seen} frames: nothing was animating')
            if hides or shows: problems.append(f'the caret was hidden {hides}x and shown {shows}x across {frames_seen} frames')
        elif step[0] == 'resize_burst_typing':
            # A burst of size changes with a key typed in the middle of it: the key echoes at once (inside the
            # settle window), and the whole burst blanks the screen once.
            before = len(raw)
            # Back to back, no pump between: the signals must all land inside the 120ms settle.
            for n, lines in enumerate((63, 40, 32)):
                fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', lines, 70, 0, 0))
                screen.resize(lines=lines, columns=70)
                if n == 1:
                    os.write(fd, step[1].encode())
            pump(0.08)
            if step[1] not in '\n'.join(screen.display): problems.append(f'{step[1]!r} typed during a resize burst did not echo before the burst settled')
            pump(0.8)
            burst = bytes(raw[before:])
            clears = burst.count(b'\x1b[2J')
            if os.environ.get('SHOW_RAW'): print('BURST', [(m.start(), burst[max(0,m.start()-120):m.start()+10]) for m in re.finditer(rb'\x1b\[2J', burst)])
            if os.environ.get('SHOW_SNAPS'): print(f'RESIZE {len(burst)} bytes, {clears} clears, {burst.count(b"?2026h")} frames')
            if clears != 1: problems.append(f'the resize burst cleared the screen {clears}x, expected once')
            if step[1] not in '\n'.join(screen.display): problems.append(f'{step[1]!r} is gone after the resize settled')
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
        elif step[0] == 'click':
            # A tap: press and release on the same cell, on the LAST row that
            # shows the phrase (the middle of its first cell's word).
            where = [(row, line.find(step[1])) for row, line in enumerate(screen.display) if step[1] in line]
            if not where:
                problems.append(f'could not find {step[1]!r} on screen to click'); continue
            row, col = where[-1]
            os.write(fd, f'\x1b[<0;{col + 1};{row + 1}M'.encode()); pump(0.05)
            os.write(fd, f'\x1b[<0;{col + 1};{row + 1}m'.encode()); pump(0.4)
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
    # Whether ClikCode ended by itself on the two Ctrl+C presses, and how.
    exit_info = {'by_ctrl_c': False, 'status': None}
    for _ in range(2):
        try: os.write(fd, b'\x03')
        except OSError: pass
        pump(0.4)
    try:
        reaped, status = os.waitpid(pid, os.WNOHANG)
        if reaped == pid: exit_info = {'by_ctrl_c': True, 'status': status}; pid = -1
    except ChildProcessError: pid = -1
    if pid > 0:
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
        for left, right in zip(turn.get('blocks', []), turn.get('blocks', [])[1:]):
            if left + right.split()[0] in final: problems.append(f'jammed with no paragraph break: {left!r} / {right!r}')
    for phrase in spec.get('never', []):
        shown = [t for t, text in frames if phrase in text]
        if shown: problems.append(f'shown in {len(shown)} frame(s), first at {shown[0]:.2f}s, and never should be: {phrase!r}')
    # Like 'never', by regular expression.
    for pattern in spec.get('never_pattern', []):
        import re as regex
        shown = [t for t, text in frames if regex.search(pattern, text)]
        if shown: problems.append(f'matched in {len(shown)} frame(s), first at {shown[0]:.2f}s, and never should be: {pattern!r}')
    # Each time the phrase appears it stays at least this many seconds.
    for phrase, least in spec.get('min_visible', {}).items():
        shown_at = None
        for t, text in frames:
            if phrase in text and shown_at is None: shown_at = t
            elif phrase not in text and shown_at is not None:
                if t - shown_at < least: problems.append(f'{phrase!r} on screen only {t - shown_at:.2f}s, expected {least}s at least')
                shown_at = None
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
    # A regular expression that some TRANSCRIPT row of the final screen matches
    # (the footer, whose path holds the scenario's name, is not a row).
    for pattern in spec.get('final_rows_match', []):
        if not any(re.search(pattern, row) for row in (transcript_rows(final) or final.split('\n'))):
            problems.append(f'no transcript row on the final screen matches {pattern!r}')
    for phrase in spec.get('final_contains', []):
        if phrase not in final: problems.append(f'expected on the final screen: {phrase!r}')
    # Top to bottom on the final screen, in this order.
    at_final = 0
    for phrase in spec.get('final_in_order', []):
        found = final.find(phrase, at_final)
        if found < 0: problems.append(f'not on the final screen after what came before it: {phrase!r}')
        else: at_final = found + len(phrase)
    for phrase, count in spec.get('final_count', {}).items():
        if final.count(phrase) != count: problems.append(f'on screen {final.count(phrase)}x at the end, expected {count}x: {phrase!r}')
    for phrase in spec.get('final_once', []):
        if final.count(phrase) != 1: problems.append(f'on screen {final.count(phrase)}x at the end, expected once: {phrase!r}')
    # A phrase on the same screen row in two snapshots (a tapped row stays under the finger).
    for name, phrase in spec.get('snap_same_row', []):
        def last_row(snap):
            rows_with = [i for i, line in enumerate(snaps.get(snap, [])) if phrase in line]
            return rows_with[-1] if rows_with else None
        if last_row(name) is None: problems.append(f'{phrase!r} not on the {name!r} screen')
        elif last_row(name) != last_row('closed'): problems.append(f'{phrase!r} is on row {last_row(name)} on the {name!r} screen, was on row {last_row("closed")}')
    # The composer stays on its screen row in every named snapshot, as it was in 'closed'.
    def composer_row(snap):
        rows_with = [i for i, line in enumerate(snaps.get(snap, [])) if re.match(r'^  ›( |$)', line)]
        return rows_with[-1] if rows_with else None
    for name in spec.get('snap_composer_same', []):
        if composer_row(name) is None: problems.append(f'no composer on the {name!r} screen')
        elif composer_row(name) != composer_row('closed'): problems.append(f'the composer is on row {composer_row(name)} on the {name!r} screen, was on row {composer_row("closed")}')
    # A phrase on the same row in two named snapshots (a chat row across an event).
    for first, second, phrase in spec.get('snap_pair_same_row', []):
        def row_in(snap):
            rows_with = [i for i, line in enumerate(snaps.get(snap, [])) if phrase in line]
            return rows_with[-1] if rows_with else None
        if row_in(first) is None or row_in(second) is None: problems.append(f'{phrase!r} not on both the {first!r} and {second!r} screens')
        elif row_in(first) != row_in(second): problems.append(f'{phrase!r} moved from row {row_in(first)} ({first!r}) to row {row_in(second)} ({second!r})')
    # Rows right under a row, in order: the first of them is the very next row.
    for name, (anchor, phrases) in spec.get('snap_rows_after', {}).items():
        rows_of = [line for line in snaps.get(name, [])]
        at = [i for i, line in enumerate(rows_of) if anchor in line]
        if not at: problems.append(f'{anchor!r} not on the {name!r} screen'); continue
        under = rows_of[at[-1] + 1:at[-1] + 1 + len(phrases)]
        for phrase, row in zip(phrases, under):
            if phrase not in row: problems.append(f'on the {name!r} screen the rows under {anchor!r} are {[r.strip() for r in under]!r}, expected {phrases!r}')
    # The rows just above the composer must not show these.
    for name, phrases in spec.get('snap_bottom_lacks', {}).items():
        rows_here = transcript_rows('\n'.join(snaps.get(name, []))) or []
        shown = '\n'.join(rows_here[-3:])
        for phrase in phrases:
            if phrase in shown: problems.append(f'at the bottom of the {name!r} screen, above the composer: {phrase!r}')
    for name, phrases in spec.get('snap_lacks', {}).items():
        shown = '\n'.join(snaps.get(name, []))
        for phrase in phrases:
            if phrase in shown: problems.append(f'on the {name!r} screen, and never should be: {phrase!r}')
    for name, phrases in spec.get('snap_rules_lack', {}).items():
        shown = '\n'.join(line for line in snaps.get(name, []) if line.lstrip().startswith('─'))
        for phrase in phrases:
            if phrase in shown: problems.append(f'on a rule of the {name!r} screen, and never should be: {phrase!r}')
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
    # ---- Global duplicate check --------------------------------------------
    # A row of the transcript on screen twice is the display bug every fix so
    # far was about (one row, two sources). The fake's own stub call -- the
    # `git log` between blocks, run once per block gap -- is the one repeat a
    # scenario cannot avoid; anything else a scenario repeats on purpose is in
    # `dup_ok` (substrings). `no_dup_check` is a reason string, never a bare True.
    if not spec.get('no_dup_check'):
        stub_calls = sum(max(0, len(turn.get('blocks', [])) - 1) for turn in spec['turns'])
        dup_ok = spec.get('dup_ok', [])
        def allowed(row):
            if any(phrase in row for phrase in dup_ok): return 1 << 30
            if 'git log -1 --oneline' in row or row == 'abc123 fix': return max(1, stub_calls)
            return 1
        shown_from = next((i for i, (t, _) in enumerate(frames) if typed_at is not None and t >= typed_at), len(frames))
        final_doubled = doubled_rows(final, allowed)
        # The frame each row first doubled and stayed doubled to the end.
        for row, count in final_doubled.items():
            at = len(frames) - 1
            while at - 1 >= shown_from and row in doubled_rows(frames[at - 1][1], allowed): at -= 1
            problems.append(f'DUPLICATED on the final screen ({count}x), doubled from frame {at} ({frames[at][0]:.2f}s): {row!r}')
        gone = {}
        for index in range(shown_from, len(frames)):
            if not frame_complete[index]: continue
            for row, count in doubled_rows(frames[index][1], allowed).items():
                if row in final_doubled: continue
                first, last, n = gone.get(row, (index, index, 0))
                gone[row] = (first, index, n + 1)
        for row, (first, last, n) in gone.items():
            problems.append(f'DOUBLED on screen in {n} frame(s), first at frame {first} ({frames[first][0]:.2f}s), last {last}, gone by the end: {row!r}')

    # ---- Order and state checks over every complete frame ------------------
    def complete_frames():
        return [(i, t, text) for i, (t, text) in enumerate(frames) if frame_complete[i] and typed_at is not None and t >= typed_at]
    # Frames, one per complete synchronized update, as the bytes the app wrote.
    SYNC_END = b'\x1b[?2026l'
    def written_frames(first=0, last=None):
        data, at, out = bytes(raw[first:last]), 0, []
        while True:
            end = data.find(SYNC_END, at)
            if end < 0: return out
            out.append(data[at:end + len(SYNC_END)]); at = end + len(SYNC_END)
    def rows_written(chunk): return [int(n) for n in re.findall(rb'\x1b\[(\d+);\d+H', chunk)]
    # No frame addresses a row below the screen: a terminal clamps it to the last row, and what
    # was meant for the row below lands on top of the composer.
    if spec.get('rows_within_screen'):
        screen_rows = spec.get('rows', ROWS)
        low = [(n, max(r)) for n, r in enumerate(rows_written(c) for c in written_frames()) if r and max(r) > screen_rows]
        if low: problems.append(f'{len(low)} frame(s) addressed a row below the {screen_rows}-row screen, first frame {low[0][0]} (row {low[0][1]})')
    # From the mark on, the composer's two rules are on screen in every complete frame.
    if spec.get('composer_whole_after_mark') and marked_at is not None:
        broken = [i for i, (t, text) in enumerate(frames) if i >= marked_at and (marked_end_at is None or i < marked_end_at) and frame_complete[i]
                  and len([1 for line in text.split('\n') if RULE_ROW.match(line.rstrip())]) != 2]
        if broken: problems.append(f'the composer was not whole in {len(broken)} complete frame(s) after the mark, first frame {broken[0]} ({frames[broken[0]][0]:.2f}s)')
    # From the mark on, no frame draws more than this many rows: a scroll, the spinner, a clock.
    # A whole-screen rewrite is every row of the history, and shows as a flash where the
    # terminal does not hold a frame whole.
    if spec.get('cheap_frames_after_mark') and marked_raw_at is not None:
        limit = spec['cheap_frames_after_mark']
        dear = [(n, len(set(r))) for n, r in enumerate(rows_written(c) for c in written_frames(marked_raw_at, marked_raw_end_at)) if len(set(r)) > limit]
        if dear: problems.append(f'{len(dear)} frame(s) after the mark drew more than {limit} rows (the history rewritten, not shifted): first {dear[0][0]} with {dear[0][1]} rows')
    def board_frame(text): return 'enter open' in text or 'enter start a new chat' in text
    # A conversation that was on screen is on screen in every complete frame that is not the board:
    # leaving it for the board and coming back are each one change, never a frame with the chat
    # missing between them. (A turn that is working used to be wiped before the board was drawn,
    # and the board wiped before the turn was drawn again.)
    for phrase in spec.get('shown_outside_board', []):
        begun = next((i for i, _, text in complete_frames() if phrase in text), None)
        if begun is None: problems.append(f'shown_outside_board: {phrase!r} was never on screen'); continue
        gone = [(i, t) for i, t, text in complete_frames() if i > begun and not board_frame(text) and phrase not in text]
        if gone: problems.append(f'{phrase!r} missing from {len(gone)} complete frame(s) that are not the board, first at frame {gone[0][0]} ({gone[0][1]:.2f}s)')
    # A line of the conversation stays on one screen row in every complete frame that shows it, the
    # board's between them (from the first board on): opening a conversation puts its rows where they were, they do not hop.
    for phrase in spec.get('same_row', []):
        rows, boarded = {}, False
        for i, t, text in complete_frames():
            if board_frame(text): boarded = True; continue
            if not boarded or 'Press Ctrl+C again' in text or '─ Stopped ─' in text or 'Stop held' in text: continue  # the harness's own shutdown
            for n, line in enumerate(text.split('\n')):
                if phrase in line: rows.setdefault(n, (i, t))
        if os.environ.get('SAMEROW_AFTER_BOARD'):
            frames = list(complete_frames()); lastb = max(k for k, f in enumerate(frames) if board_frame(f[2]))
            for i, t, text in frames[lastb:lastb + 4]:
                print(f'DUMP {i} {t:.2f}'); print('\n'.join(f'{n:2d}|{l.rstrip()[:90]}' for n, l in enumerate(text.split('\n')) if l.strip())); print('ENDDUMP')
        for want in filter(None, os.environ.get('SAMEROW_DUMP', '').split(',')):
            for i, t, text in complete_frames():
                if i == int(want): print(f'DUMP {i}'); print('\n'.join(f'{n:2d}|{l.rstrip()}' for n, l in enumerate(text.split('\n')))); print('ENDDUMP')
        if os.environ.get('SAMEROW_TRACE'):
            last = None
            for i, t, text in complete_frames():
                at = [n for n, line in enumerate(text.split('\n')) if phrase in line]
                if board_frame(text): at = ['BOARD']
                if at != last:
                    print('TRACE', phrase, i, f'{t:.2f}', at)
                    if os.environ.get('SAMEROW_TRACE') == 'full' and last not in (None, ['BOARD']) and at != ['BOARD'] or (os.environ.get('SAMEROW_TRACE') == 'full' and at == [] and last == ['BOARD']):
                        print('\n'.join(f'  {n:2d}|{l.rstrip()[:80]}' for n, l in enumerate(text.split('\n')) if l.strip()))
                    last = at
        if len(rows) > 1: problems.append(f'{phrase!r} moved between screen rows {sorted(rows)} (first frames {[rows[r][0] for r in sorted(rows)]})')
    # A clock on screen only counts up: coming back from the board does not start it again at 0s.
    for pattern in spec.get('timer_counts_up', []):
        last, back = None, []
        for i, t, text in complete_frames():
            if board_frame(text) or 'Stopped' in text or 'Stop held' in text: continue
            found = re.search(pattern, text)
            if not found: continue
            seconds = int(found.group(1))
            if last is not None and seconds < last: back.append((i, t, last, seconds))
            last = seconds
        if back: problems.append(f'{pattern!r}: the clock went back {back[0][2]}s -> {back[0][3]}s at frame {back[0][0]} ({back[0][1]:.2f}s), {len(back)} time(s)')
    # The board hands the screen over in one change: from the first frame that shows the board
    # to the next that does not, every complete frame is the board or has a composer (never
    # the conversation being left, bare), and the composer's rules never change row.
    if spec.get('stable_handoff'):
        def rule_rows(text):
            lines = [line.rstrip() for line in text.split('\n')]
            return [n for n, line in enumerate(lines) if RULE_ROW.match(line)]
        seen_board, bare, composer_rows = False, [], set()
        for i, t, text in complete_frames():
            rules = rule_rows(text)
            if len(rules) >= 2: composer_rows.add((rules[-2], rules[-1]))
            if board_frame(text): seen_board = True; continue
            if seen_board and len(rules) < 2: bare.append((i, t))
        if not seen_board: problems.append('stable_handoff: the board was never on screen')
        if bare: problems.append(f'no composer in {len(bare)} complete frame(s) after the board was shown (the conversation left, bare), first at frame {bare[0][0]} ({bare[0][1]:.2f}s)')
        if len(composer_rows) > 1: problems.append(f'the composer changed rows: {sorted(composer_rows)}')
    # ('above', 'below'): wherever both are on screen, `above` is higher up.
    for upper, lower in spec.get('always_order', []):
        bad = []
        for i, t, text in complete_frames():
            rows = transcript_rows(text) or text.split('\n')
            a, b = first_row(rows, upper), first_row(rows, lower)
            if a is not None and b is not None and a > b: bad.append((i, t))
        if bad: problems.append(f'{lower!r} drawn above {upper!r} in {len(bad)} frame(s), first at frame {bad[0][0]} ({bad[0][1]:.2f}s)')
    # Both on screen in one frame at least once (two concurrent slots).
    for left, right in spec.get('ever_together', []):
        if not any(left in text and right in text for _, _, text in complete_frames()):
            problems.append(f'{left!r} and {right!r} were never on screen together')
    # ('shown', 'unwanted'): after `shown` first appears, `unwanted` never does.
    for shown, unwanted in spec.get('never_after', []):
        begun = next((i for i, _, text in complete_frames() if shown in text), None)
        if begun is None: problems.append(f'never_after: {shown!r} was never on screen'); continue
        bad = [(i, t) for i, t, text in complete_frames() if i >= begun and unwanted in text]
        if bad: problems.append(f'{unwanted!r} on screen in {len(bad)} frame(s) after {shown!r} appeared, first at frame {bad[0][0]} ({bad[0][1]:.2f}s)')
    # ('from', 'until'): in every complete frame from `from` first appearing to
    # `until` first appearing the screen carries a status row or an approval.
    for first, last in spec.get('status_always', []):
        begun = next((i for i, _, text in complete_frames() if first in text), None)
        ended = next((i for i, _, text in complete_frames() if last in text and (begun is None or i > begun)), None)
        if begun is None or ended is None: problems.append(f'status_always: {first!r} .. {last!r} never both on screen'); continue
        blank = [(i, t) for i, t, text in complete_frames() if begun <= i < ended
                 and not any(STATUS_ROW.match(row) or 'Allow' in row for row in (transcript_rows(text) or text.split('\n')) + text.split('\n')[-12:])]
        if blank: problems.append(f'no status row in {len(blank)} frame(s) between {first!r} and {last!r}, first at frame {blank[0][0]} ({blank[0][1]:.2f}s)')
    # Every table on screen is aligned, in the final screen and in each frame.
    if spec.get('table_aligned'):
        bad = table_misaligned(final)
        if bad: problems.append(f'misaligned table row on the final screen: {bad!r}')
        for i, t, text in complete_frames():
            bad = table_misaligned(text)
            if bad: problems.append(f'misaligned table row at frame {i} ({t:.2f}s): {bad!r}'); break
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


    if spec.get('dump'):
        json.dump({'start': wall_start, 'frames': frames, 'chunk_at': chunk_at, 'complete': frame_complete, 'typed_at': typed_at,
                   'exit': exit_info, 'problems': problems, 'final': final, 'raw_errors': bool(re.search(rb'node:internal|Traceback|UnhandledPromiseRejection', bytes(raw)))},
                  open(spec['dump'], 'w'))
    open(os.path.join(root, 'capture.bin'), 'wb').write(bytes(raw))
    open(os.path.join(root, 'final.txt'), 'w').write(final)
    if frames2: open(os.path.join(root, 'final2.txt'), 'w').write(final2)
    if keep or problems:
        # Every distinct screen, timed: the way to see which draw did it.
        for name, shots in (('frames.txt', frames), ('frames2.txt', frames2)):
            if not shots: continue
            with open(os.path.join(root, name), 'w') as log:
                last = None
                for number, (t, text) in enumerate(shots):
                    if text == last: continue
                    last = text
                    log.write(f'===== {t:.2f}s #{number}\n' + '\n'.join(line.rstrip() for line in text.split('\n') if line.strip()) + '\n')
    while GATEWAY_STOPS: GATEWAY_STOPS.pop()()
    if not problems and not keep: shutil.rmtree(root, ignore_errors=True)
    return problems, root, final


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('entry', nargs='?', default=os.path.join(REPO, 'dist', 'index.js'))
    parser.add_argument('--repeat', type=int, default=1)
    parser.add_argument('--only')
    parser.add_argument('--keep', action='store_true')
    # Every scenario that names no width of its own runs at this one.
    parser.add_argument('--cols', type=int)
    # Lists the scenarios marked `expect_fail` (acceptance tests for a stream
    # that has not landed here) with the stream that makes each pass, and exits.
    parser.add_argument('--expect-fail', action='store_true', dest='list_expected')
    args = parser.parse_args()
    if args.list_expected:
        marked = [(spec['expect_fail'], name) for name, spec in SCENARIOS.items() if spec.get('expect_fail')]
        for stream, name in sorted(marked): print(f'{stream:12} {name}')
        sys.exit(0)
    entry = os.path.abspath(args.entry)
    failed = 0
    for name, spec in SCENARIOS.items():
        if args.only and name not in args.only.split(','): continue
        if args.cols and 'cols' not in spec: spec = {**spec, 'cols': args.cols}
        for attempt in range(1, args.repeat + 1):
            problems, root, final = run(name, spec, entry, args.keep)
            expected = spec.get('expect_fail')
            if expected: status = 'XFAIL' if problems else 'XPASS'
            else: status = 'PASS' if not problems else 'FAIL'
            note = f'  (expected to fail until: {expected})' if status == 'XFAIL' else '  (passes now: remove its expect_fail mark)' if status == 'XPASS' else ''
            print(f'{status}  {name}  [{attempt}/{args.repeat}]{note}' + ('' if not problems else f'  capture: {root}'))
            for problem in problems: print(f'        - {problem}')
            if status in ('FAIL', 'XPASS'): failed += 1
            if problems and status == 'FAIL':
                print('        final screen:\n' + '\n'.join(f'          {line.rstrip()}' for line in final.split('\n') if line.strip()))
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()
