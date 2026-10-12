"""ClikCode's own agent loop through the fake Gateway (fake-gateway.mjs), timed
the way matrix.py times a native harness: the server logs every request's
arrival and every frame it writes (Date.now()), the runner stamps every pty
read, and the difference is ClikCode's.

    uv run --with pyte scripts/tui-e2e/matrix/gateway_lag.py [--repeat N] [dist/index.js]

Per phase (ms): submit->request (everything ClikCode does before the model's
first request: the native counterpart is submit->spawn + spawn->prompt),
echo (prompt painted), spinner (first status row), request->first text paint
(server's first text frame to the screen), end->summary (the server's last
byte to the `Worked for` line). Nothing here reaches beyond loopback.
"""
import argparse, importlib.util, json, os, statistics, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))
_spec = importlib.util.spec_from_file_location('tui_e2e_run', os.path.join(REPO, 'scripts', 'tui-e2e', 'run.py'))
runner = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(runner)

PROMPT = 'GW-TOOLS run the parity turn'


def once(entry):
    dump = os.path.join(tempfile.mkdtemp(prefix='gwlag-'), 'dump.json')
    spec = {'turns': [{}], 'harness': 'grok', 'setup': runner.gateway_fake(), 'startup': 5, 'dump': dump, 'no_dup_check': 'timing run',
            'steps': [('keys', '\r'), ('settle', 3), ('type', PROMPT), ('wait_for', 'Worked for', 40), ('settle', 2)], 'watch': []}
    problems, root, _final = runner.run('gateway-lag', spec, os.path.abspath(entry), True)
    data = json.load(open(dump))
    records = [json.loads(line) for line in open(os.path.join(root, 'gateway.jsonl')) if line.strip()]
    submit = (data['start'] + data['typed_at']) * 1000.0
    frames, at = data['frames'], data['chunk_at']
    first_request = next(r for r in records if r['ev'] == 'request')
    first_text = next(r for r in records if r['ev'] == 'frame' and 'Starting' in r['delta'])
    last = [r for r in records if r['ev'] == 'end'][-1]

    def painted(predicate, after=0.0):
        for index, (_, text) in enumerate(frames):
            if at[index] * 1000.0 >= after and predicate(text): return at[index] * 1000.0
        return None
    echo = painted(lambda t: any('run the parity turn' in row for row in (runner.transcript_rows(t) or [])), submit)
    spin = painted(lambda t: any(runner.SPINNER_ROW.match(r) or runner.STATUS_ROW.match(r) for r in t.split('\n')), submit)
    text = painted(lambda t: 'Starting the work' in t, first_text['t'] - 5)
    summary = painted(lambda t: 'Worked for' in t, last['t'] - 5)
    return {'problems': problems, 'submit_to_request': first_request['arrived'] - submit, 'echo': None if echo is None else echo - submit,
            'spinner': None if spin is None else spin - submit, 'text_paint': None if text is None else text - first_text['t'],
            'end_to_summary': None if summary is None else summary - last['t']}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('entry', nargs='?', default=os.path.join(REPO, 'dist', 'index.js'))
    parser.add_argument('--repeat', type=int, default=3)
    args = parser.parse_args()
    runs = [once(args.entry) for _ in range(args.repeat)]
    for run in runs: print(json.dumps(run))
    keys = ['submit_to_request', 'echo', 'spinner', 'text_paint', 'end_to_summary']
    print('median ms: ' + ', '.join(f'{k}={statistics.median(r[k] for r in runs if r[k] is not None):.0f}' for k in keys))


if __name__ == '__main__':
    main()
