"""The harness matrix: every catalog harness, wired through ClikCode's REAL
catalog entry, and the latency ClikCode itself adds on the way.

For each harness one scripted turn (turn-script.mjs) is played by the one fake
vendor (fake-vendor.mjs, installed on PATH under the harness's real binary
name) through the real TUI in a pty, using run.py's runner (isolated HOME and
CLIKCODE_HOME, a PATH of the fake bin + node + /usr/bin + /bin, the emulated
screen after every chunk). The vendor timestamps every write with Date.now();
the runner timestamps every pty read with time.time(): one machine clock, and
the vendor's own delays are fixed, so what is left over is ClikCode's.

    uv run --with pyte scripts/tui-e2e/matrix/matrix.py run [--only a,b] [--repeat N] [--out DIR] [dist/index.js]
    uv run --with pyte scripts/tui-e2e/matrix/matrix.py compare BASE.json NEW.json

Run it under a cap, one harness at a time:
    systemd-run --user --scope -q -p MemoryMax=3G uv run --with pyte ... run --only claude

AGENTS.md: nothing here ever starts a real vendor. The PATH holds only fakes.
"""
import argparse, importlib.util, json, os, re, shutil, statistics, subprocess, sys, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import lag  # noqa: E402

REPO = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))
_spec = importlib.util.spec_from_file_location('tui_e2e_run', os.path.join(REPO, 'scripts', 'tui-e2e', 'run.py'))
runner = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(runner)  # run.py's pty/pyte/isolation code, imported, not copied

PROMPT = 'run the matrix turn'
WORD_MS = 25
SUMMARY = re.compile(r'Worked for|Stopped after')


def node_json(args):
    return json.loads(subprocess.check_output(['node', *args], cwd=REPO, text=True))


def catalog_of(entry):
    return node_json([os.path.join(HERE, 'catalog-dump.cjs'), os.path.join(os.path.dirname(entry), 'harness-catalog.cjs')])


def turn_of(entry, command):
    return node_json([os.path.join(HERE, 'turn-script.mjs'), os.path.join(os.path.dirname(entry), 'harness-catalog.cjs'), command])


# ---- credentials ------------------------------------------------------------
def expand_auth(path, home):
    """The catalog's `${VAR:-default}` and `~` against the isolated home, with
    every `*` segment a fixed name."""
    path = re.sub(r'\$\{[A-Z0-9_]+:-([^}]*)\}', r'\1', path)
    if path.startswith('~'): path = home + path[1:]
    return path.replace('*', 'x')


def provision_auth(harness, home):
    """Sign the harness in the way its OWN catalog entry checks: the first
    `authFiles` entry written with the text it looks for, else (no file named)
    nothing -- a harness with a status command is answered by the fake's status
    and one with no evidence at all is assumed signed in by ClikCode itself.
    Returns a string describing it, or a skip reason."""
    files = harness['authFiles']
    if files:
        entry = files[0]
        target = expand_auth(entry['path'], home)
        contains = entry.get('contains')
        if target.endswith('/'):
            os.makedirs(target, exist_ok=True)
            with open(os.path.join(target, 'credential'), 'w') as handle: handle.write('fake\n')
            return f'dir {target}'
        os.makedirs(os.path.dirname(target), exist_ok=True)
        if contains is None: body = '{"fake": true}\n'
        elif target.endswith('.json') and re.fullmatch(r'"[^"]+"', contains): body = '{%s: "fake"}\n' % contains
        elif target.endswith('.json') and re.fullmatch(r'"[^"]+":', contains): body = '{%s "fake"}\n' % contains
        else: body = contains + '\n'
        with open(target, 'w') as handle: handle.write(body)
        return f'file {target}'
    if harness['statusArgv']: return 'status command (answered by the fake)'
    return 'no evidence declared (ClikCode assumes signed in)'


# ---- one run ------------------------------------------------------------------
def install(fakebin, harness, vendor_js):
    for name in {harness['binary'], harness['acpBinary']} - {None}:
        link = os.path.join(fakebin, name)
        if os.path.lexists(link): os.remove(link)
        os.symlink(vendor_js, link)


def run_once(entry, harness, turn, keep=False, concurrency=1):
    vendor_js = os.path.join(HERE, 'fake-vendor.mjs')
    os.chmod(vendor_js, 0o755)
    work = tempfile.mkdtemp(prefix=f'matrix-{harness["command"]}-')
    dump = os.path.join(work, 'dump.json')
    emit_log = os.path.join(work, 'emit.jsonl')
    info = {}

    def setup(context):
        install(context['fakebin'], harness, vendor_js)
        context['env'].update({
            'FAKE_CATALOG': os.path.join(os.path.dirname(entry), 'harness-catalog.cjs'),
            'FAKE_EMIT_LOG': emit_log, 'FAKE_DELAY_MS': str(WORD_MS), 'FAKE_PROMPT': PROMPT,
        })
        info['auth'] = provision_auth(harness, context['home'])

    final_marker = turn['expect'][-1]['marker']
    spec = {
        'setup': setup, 'dump': dump, 'turns': [{}], 'harness': harness['binary'],
        'startup': 6, 'no_clear_after_type': False,
        'steps': [('type', PROMPT), ('wait_for', final_marker, 45), ('settle', 4)],
        'watch': [],
        # Between the turn's first text and its closing text a status row is always up; a one-reply
        # harness has only the closing text, so there is no span to hold it to.
        'status_always': [(turn['expect'][0]['marker'], final_marker)] if turn['expect'][0]['marker'] != final_marker else [],
        'dup_ok': [],
    }
    problems, root, final = runner.run(f'matrix-{harness["command"]}', spec, os.path.abspath(entry), keep)
    result = {'problems': problems, 'work': work, 'auth': info.get('auth')}
    try: result['dump'] = json.load(open(dump))
    except (OSError, ValueError): result['dump'] = None
    try: result['records'] = [json.loads(line) for line in open(emit_log) if line.strip()]
    except OSError: result['records'] = []
    return result


# ---- the checks ---------------------------------------------------------------
def rows_of(text):
    return [row.rstrip() for row in text.split('\n')]


def find_row(rows, phrase):
    return next((i for i, row in enumerate(rows) if phrase in row), None)


def evaluate(harness, turn, result, concurrency):
    """The record for one harness run: wired, checks, marks.

    `wired` is the wire: the prompt became the transport the catalog names, and
    every capability the catalog declares true reached the screen at all.
    `standard` is TURN_FLOW_STANDARD held to what reached the screen (order,
    once, nesting, the kept plan row, summary, clean exit)."""
    checks = []

    def check(name, ok, rule, detail='', kind='standard'):
        checks.append({'name': name, 'kind': kind, 'ok': bool(ok), 'rule': rule, **({'detail': detail} if detail else {})})

    dump = result['dump']
    expect = turn['expect']
    caps = turn['capabilities']
    ability = turn['ability']
    record = {'harness': harness['command'], 'transport': harness['transport'], 'parser': harness['parser'], 'auth': result['auth'],
              'capabilities': caps, 'concurrency': concurrency}
    if not dump or not result['records']:
        record.update({'wired': False, 'standard': False, 'marks': {}, 'failing': ['ran: no vendor activity was recorded'],
                       'checks': [{'name': 'ran', 'kind': 'wire', 'ok': False, 'rule': 'the turn reached the vendor'}]})
        if dump: record['final'] = dump['final']
        return record
    frames, chunk_at, final = dump['frames'], dump['chunk_at'], dump['final']
    complete = dump['complete']
    start = dump['start']
    submit_ms = (start + dump['typed_at']) * 1000.0 if dump['typed_at'] is not None else None
    records = result['records']
    final_rows = rows_of(final)
    markers = [item['marker'] for item in expect]
    emitted = lag.marker_emit_times(records, markers)
    ever = lambda marker: any(marker in text for _, text in frames)

    # --- the wire
    recv = next((r for r in records if r.get('ev') == 'recv' and r.get('matched', True)), None)
    want = {'acp': 'session/prompt', 'codex-app-server': 'turn/start'}.get(harness['transport'])
    got = recv.get('what') if recv else None
    ok = recv is not None and (got == want if want else got in ('argv', 'stdin'))
    check('transport-selected', ok, f'catalog transport `{harness["transport"]}`: the typed prompt reaches the vendor over it',
          f'prompt arrived as {got!r}' if not ok else '', 'wire')
    never = [m for m in markers if m in emitted and not ever(m)]
    check('markers-reach-screen', not never, 'every event the vendor wrote reaches the screen (as some frame)', ', '.join(never), 'wire')
    if caps['thinking'] and ability['live']:
        check('thinking-reaches-screen', ever('mkrThinkHead'), 'catalog capability thinking=true: the thought reaches the screen', kind='wire')
    if caps['childActivity'] and ability['tools']:
        check('children-reach-screen', ever('mkrChildOne') and ever('mkrChildTwo'), 'catalog capability childActivity=true: the sub-agent\'s calls reach the screen', kind='wire')
    if caps['plan'] and ability['live']:
        check('plan-reaches-screen', ever('mkrPlanOne') and ever('mkrPlanTwo'), 'catalog capability plan=true: the plan reaches the screen', kind='wire')
    if caps['toolOutput'] and ability['tools']:
        check('tool-output-reaches-screen', ever('mkrSoloOut') and ever('mkrOutA') and ever('mkrOutB'),
              'catalog capability toolOutput=true: a tool result\'s text reaches the screen', kind='wire')
    if caps['usage'] and ability['tools']:
        # The summary line ends a turn that ran calls or took 10 s (endsWithSummary); a short toolless
        # turn draws none, and its usage lives in the status line while it runs.
        row = next((r for r in final_rows if SUMMARY.search(r)), '')
        check('usage-reaches-screen', bool(re.search(r'tokens|\$\d', row)),
              'catalog capability usage=true: per-turn usage (tokens, cost) reaches the summary line',
              f'summary row: {row.strip()!r}', 'wire')

    # --- the standard, on what reached the screen
    persisting = [item for item in expect if item['persists'] and item['kind'] != 'plan']
    for item in persisting:
        count = final.count(item['marker'])
        check(f'once:{item["marker"]}', count == 1, 'TURN_FLOW_STANDARD 1.1/10: every row of the turn is on screen exactly once',
              '' if count == 1 else f'on screen {count}x in the final screen')
    where = {}
    for item in persisting:
        at = find_row(final_rows, item['marker'])
        if at is not None: where[item['marker']] = (at, final_rows[at].find(item['marker']))
    # Rows sit in the order they BEGAN; a call's output belongs under its own
    # call row, whichever call finished first (1.4: completion never decides).
    rows_in_order = [item for item in persisting if item['kind'] != 'output']
    order = [where[item['marker']] for item in rows_in_order if item['marker'] in where]
    check('order', order == sorted(order) and len(order) == len(rows_in_order),
          'TURN_FLOW_STANDARD 1.4: rows keep emission order; parallel calls keep START order',
          '' if order == sorted(order) else 'final screen order: ' + ' < '.join(sorted(where, key=where.get)))
    for item in persisting:
        if item['kind'] != 'output' or item['marker'] not in where or item['after'] not in where: continue
        gap = where[item['marker']][0] - where[item['after']][0]
        check(f'output-under-call:{item["marker"]}', 0 < gap <= 2, 'TURN_FLOW_STANDARD 1.4/2: a call\'s output sits under that call, not under the call that finished last',
              '' if 0 < gap <= 2 else f'{gap} rows from its call')
    if caps['thinking'] and ability['live']:
        row = next((r for r in final_rows if 'Thought for' in r), None)
        check('thought-row-kept', row is not None and 'mkrThinkHead' in row,
              'TURN_FLOW_STANDARD 4: the settled thought row keeps its heading (`Thought for Ns · heading`)',
              'no `Thought for` row on the final screen' if row is None else f'row without heading: {row.strip()}')
    else:
        check('no-thought-row', not any('Thought for' in r for r in final_rows),
              'TURN_FLOW_STANDARD 12: a capability declared false draws nothing, never a guessed row')
    if caps['childActivity'] and ability['tools']:
        nested = False
        detail = 'no complete frame showed both children under their agent row'
        indent = lambda r: len(r) - len(r.lstrip())
        for index, (_, text) in enumerate(frames):
            if not complete[index]: continue
            rows = rows_of(text)
            agent = find_row(rows, 'mkrAgentRow')
            kids = [find_row(rows, 'mkrChildOne'), find_row(rows, 'mkrChildTwo')]
            if agent is None or None in kids: continue
            if all(agent < k <= agent + 4 and indent(rows[k]) > indent(rows[agent]) for k in kids):
                nested = True
                break
            detail = f'children at rows {kids}, agent at {agent}: ' + ' | '.join(r.strip() for r in rows[min([agent] + kids):max([agent] + kids) + 1])[:200]
        check('children-nested', nested, 'TURN_FLOW_STANDARD 5: a sub-agent\'s calls are nested under its row, deeper-indented', '' if nested else detail)
    else:
        check('no-children', not any('mkrChild' in text for _, text in frames),
              'TURN_FLOW_STANDARD 5/12: where childActivity is not declared no child row is guessed')
    if caps['plan'] and ability['live']:
        seen = final.count('mkrPlanOne')
        check('plan-kept', seen == 1 and final.count('mkrPlanTwo') == 1,
              'TURN_FLOW_STANDARD 7: finishing every step does not delete the plan; it is kept as a row at the offset it first appeared',
              f'on the final screen {seen}x (live on screen while the turn ran: {ever("mkrPlanOne")})')
    duplicates = [p for p in result['problems'] if p.startswith(('DUPLICATED', 'DOUBLED'))]
    check('no-row-twice', not duplicates, 'run.py global duplicate check: no transcript row on screen twice, on the way or at the end', '; '.join(duplicates)[:400])
    blank = [p for p in result['problems'] if p.startswith('no status row') or 'status_always' in p]
    check('no-blank-status', not blank, 'TURN_FLOW_STANDARD 9: one status line for the whole turn, no blank status frame', '; '.join(blank)[:300])
    if ability['tools']:
        check('summary-line', bool(SUMMARY.search(final)), 'TURN_FLOW_STANDARD 10: one summary line (`Worked for ...`) ends a turn that ran calls')
    exit_info = dump['exit']
    clean = exit_info['by_ctrl_c'] and exit_info['status'] == 0 and not dump['raw_errors']
    check('exit-clean', clean, 'exits on Ctrl+C with status 0 and no crash text',
          '' if clean else f'exit={exit_info} raw_errors={dump["raw_errors"]}')

    # --- latency marks
    marks = {}
    pid = lag.turn_pid(records)
    if submit_ms is not None:
        marks.update(lag.spawn_marks(records, submit_ms))
        echo = lag.first_index(frames, chunk_at, PROMPT, not_before_ms=submit_ms,
                               predicate=lambda text: any(PROMPT in row for row in (runner.transcript_rows(text) or [])))
        marks['prompt_echo_ms'] = None if echo is None else chunk_at[echo] * 1000.0 - submit_ms
        spin = lag.first_index(frames, chunk_at, None, not_before_ms=submit_ms,
                               predicate=lambda text: any(runner.SPINNER_ROW.match(r) or runner.STATUS_ROW.match(r) for r in text.split('\n')))
        marks['first_spinner_ms'] = None if spin is None else chunk_at[spin] * 1000.0 - submit_ms
        last = lag.last_vendor_ms(records, pid)
        summary_at = lag.first_index(frames, chunk_at, None, not_before_ms=last - 5 if last else None,
                                     predicate=lambda text: bool(SUMMARY.search(text))) if last else None
        marks['end_to_summary_ms'] = None if summary_at is None or last is None else chunk_at[summary_at] * 1000.0 - last
    lags = lag.paint_lags(records, frames, chunk_at, markers, pid)
    marks['emit_to_paint_ms'] = lag.summarize(list(lags.values()))
    marks['emit_to_paint_by_marker'] = lags
    feeds = [(start + frames[i][0] - chunk_at[i]) * 1000.0 for i in range(len(frames))]
    marks['emulator_feed_ms'] = lag.summarize(feeds)
    word = lambda c: f'{c["name"]}: {c["rule"]}' + (f' [{c["detail"]}]' if c.get('detail') else '')
    record.update({'checks': checks, 'marks': marks,
                   'wired': all(c['ok'] for c in checks if c['kind'] == 'wire'),
                   'standard': all(c['ok'] for c in checks if c['kind'] == 'standard'),
                   'failing': [word(c) for c in checks if not c['ok']]})
    record['final'] = final
    return record


# ---- driver -------------------------------------------------------------------
SKIP_REASONS = {
    # Goose signs in with a provider key ClikCode stores, after probing the provider's REAL endpoint with it
    # (src/harness/transport/native/login.ts routeFor/acceptsKey). The rig never sends a key, fake or not,
    # to the network; the shared ACP client is exercised by the 21 other ACP harnesses and Goose's own
    # wire shape is held by the conformance test.
    'providerConfigId': 'sign-in is a provider key ClikCode validates against the provider\'s real endpoint; the rig sends no key to the network',
}


def skip_reason(harness):
    for field, why in SKIP_REASONS.items():
        if harness.get(field): return why
    return None


def run_harness(entry, harness, repeat, concurrency, keep):
    turn = turn_of(entry, harness['command'])
    runs = []
    for attempt in range(repeat):
        result = run_once(entry, harness, turn, keep, concurrency)
        record = evaluate(harness, turn, result, concurrency)
        record['attempt'] = attempt + 1
        runs.append(record)
        shutil.rmtree(result['work'], ignore_errors=True)
    return runs


def median_marks(runs):
    """Per-mark median and spread over the repeats of one harness."""
    out = {}
    scalar = ['submit_to_spawn_ms', 'spawn_to_prompt_ms', 'submit_to_prompt_ms', 'prompt_echo_ms', 'first_spinner_ms', 'end_to_summary_ms']
    for key in scalar:
        values = [r['marks'].get(key) for r in runs if r['marks'].get(key) is not None]
        out[key] = {'median': statistics.median(values), 'min': min(values), 'max': max(values), 'n': len(values)} if values else None
    for stat in ('p50', 'p95', 'max'):
        values = [r['marks']['emit_to_paint_ms'][stat] for r in runs if r['marks'].get('emit_to_paint_ms', {}).get(stat) is not None]
        out[f'emit_to_paint_{stat}_ms'] = {'median': statistics.median(values), 'min': min(values), 'max': max(values), 'n': len(values)} if values else None
    return out


def fmt(value, digits=0):
    return '-' if value is None else f'{value:.{digits}f}'


def table(results):
    lines = ['| harness | transport / parser | wired | failing rule | submit→spawn | spawn→prompt | echo | spinner | paint p50 / p95 / max | end→summary |',
             '|---|---|---|---|---|---|---|---|---|---|']
    for item in results:
        marks = item['median']
        pick = lambda key: marks.get(key) and marks[key]['median']
        wired = 'skipped' if item.get('skipped') else ('yes' if item['wired'] else 'NO')
        if not item.get('skipped') and item['wired'] and not item['standard']: wired = 'yes (standard fails)'
        failing = item.get('skipped') or ' ; '.join(f.split(': ', 1)[0] + ' (' + f.split('TURN_FLOW_STANDARD ')[1].split(':')[0] + ')' if 'TURN_FLOW_STANDARD ' in f else f.split(':')[0]
                                                   for f in item.get('failing', []))[:240]
        spawn = pick('submit_to_spawn_ms')
        spawn_text = fmt(spawn) + (' (prewarmed)' if item.get('prewarmed') else '')
        lines.append(f'| {item["harness"]} | {item["transport"]} / {item["parser"]} | {wired} | {failing} | {spawn_text} | '
                     f'{fmt(pick("spawn_to_prompt_ms"))} | {fmt(pick("prompt_echo_ms"))} | {fmt(pick("first_spinner_ms"))} | '
                     f'{fmt(pick("emit_to_paint_p50_ms"))} / {fmt(pick("emit_to_paint_p95_ms"))} / {fmt(pick("emit_to_paint_max_ms"))} | '
                     f'{fmt(pick("end_to_summary_ms"))} |')
    return '\n'.join(lines)


RESOLUTION = ('Resolution: both clocks are the machine\'s wall clock (vendor Date.now(), integer ms; runner time.time() at the pty '
              'read). A mark is therefore +-1 ms of quantization plus the runner\'s read wake-up; the emulator\'s feed time of the '
              'previous chunk can delay a read (see `emulator_feed_ms` in the JSON). Paint marks are "first pyte frame holding the marker".')


def cmd_run(args):
    entry = os.path.abspath(args.entry)
    catalog = catalog_of(entry)
    wanted = args.only.split(',') if args.only else None
    chosen = [h for h in catalog if not wanted or h['command'] in wanted]
    out_dir = args.out or tempfile.mkdtemp(prefix='matrix-out-')
    os.makedirs(out_dir, exist_ok=True)
    results = []
    for harness in chosen:
        why = skip_reason(harness)
        if why:
            results.append({'harness': harness['command'], 'transport': harness['transport'], 'parser': harness['parser'],
                            'skipped': why, 'wired': None, 'standard': None, 'failing': [], 'runs': [], 'median': {}, 'concurrency': args.concurrency})
            print(f'SKIPPED {harness["command"]:12} {why}', flush=True)
            continue
        runs = run_harness(entry, harness, args.repeat, args.concurrency, args.keep)
        last = runs[-1]
        item = {'harness': harness['command'], 'transport': harness['transport'], 'parser': harness['parser'],
                'wired': all(r['wired'] for r in runs), 'standard': all(r['standard'] for r in runs), 'failing': last.get('failing', []), 'runs': runs, 'median': median_marks(runs),
                'prewarmed': bool(runs[-1]['marks'].get('prewarmed')), 'concurrency': args.concurrency}
        results.append(item)
        print(f'{"WIRED " if item["wired"] else "FAILED"} {harness["command"]:12} {"; ".join(item["failing"])[:300]}', flush=True)
    payload = {'entry': entry, 'repeat': args.repeat, 'concurrency': args.concurrency, 'resolution': RESOLUTION, 'results': results}
    json_path = os.path.join(out_dir, f'matrix-{args.label}.json')
    json.dump(payload, open(json_path, 'w'), indent=1)
    md = f'# Harness matrix ({args.label})\n\nEntry: `{entry}`; repeats: {args.repeat}; concurrency: {args.concurrency}.\n\n{RESOLUTION}\n\n{table(results)}\n'
    open(os.path.join(out_dir, f'matrix-{args.label}.md'), 'w').write(md)
    print(md)
    print(f'written: {json_path}')
    return 0


def cmd_compare(args):
    base, new = (json.load(open(path)) for path in (args.base, args.new))
    by_name = {item['harness']: item for item in base['results']}
    keys = ['submit_to_spawn_ms', 'spawn_to_prompt_ms', 'prompt_echo_ms', 'first_spinner_ms', 'emit_to_paint_p50_ms', 'emit_to_paint_p95_ms', 'end_to_summary_ms']
    print('| harness | mark | base median (spread) | new median (spread) | delta | verdict |\n|---|---|---|---|---|---|')
    flagged = 0
    for item in new['results']:
        before = by_name.get(item['harness'])
        if not before: continue
        for key in keys:
            a, b = before['median'].get(key), item['median'].get(key)
            if not a or not b: continue
            spread_a, spread_b = a['max'] - a['min'], b['max'] - b['min']
            delta = b['median'] - a['median']
            noise = max(spread_a, spread_b)
            verdict = 'REGRESSION' if delta > noise and delta > 0 else 'improved' if -delta > noise and delta < 0 else 'noise'
            if verdict == 'REGRESSION': flagged += 1
            print(f'| {item["harness"]} | {key} | {a["median"]:.0f} (+-{spread_a:.0f}) | {b["median"]:.0f} (+-{spread_b:.0f}) | {delta:+.0f} | {verdict} |')
    print(f'\nnoise rule: a delta of the medians is a regression only when it exceeds the larger of the two spreads (max-min over {base.get("repeat")}/{new.get("repeat")} repeats). flagged: {flagged}')
    return 1 if flagged else 0


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest='cmd', required=True)
    run = sub.add_parser('run')
    run.add_argument('entry', nargs='?', default=os.path.join(REPO, 'dist', 'index.js'))
    run.add_argument('--only')
    run.add_argument('--repeat', type=int, default=1)
    run.add_argument('--out')
    run.add_argument('--label', default='new')
    run.add_argument('--concurrency', type=int, default=1, help='how many runs share the machine (recorded; this driver runs one at a time)')
    run.add_argument('--keep', action='store_true')
    compare = sub.add_parser('compare')
    compare.add_argument('base')
    compare.add_argument('new')
    args = parser.parse_args()
    sys.exit(cmd_run(args) if args.cmd == 'run' else cmd_compare(args))


if __name__ == '__main__':
    main()
