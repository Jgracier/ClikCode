"""Sanity test of the lag arithmetic on a synthetic log: python3 test_lag.py"""
import lag

records = [
    {'t': 1000, 'pid': 7, 'ev': 'start', 'argv': ['x mkrNope'], 'execAt': 990},
    {'t': 1100, 'pid': 7, 'ev': 'recv', 'what': 'session/prompt'},
    {'t': 1200, 'pid': 7, 'ev': 'update', 'update': {'text': 'hello mkrA'}},
    {'t': 1300, 'pid': 7, 'ev': 'emit', 'rec': {'text': 'mkrB'}},
    {'t': 1400, 'pid': 7, 'ev': 'end'},
]
# Frames read at 1.215 s (mkrA), 1.330 s (mkrA + mkrB), mkrNope never shown.
frames = [(0.0, ''), (0.2, 'hello mkrA'), (0.3, 'hello mkrA\nmkrB')]
chunk_at = [1.0, 1.215, 1.330]

# The start record's argv is not a write: a marker in it is not an emission.
assert lag.marker_emit_times(records, ['mkrA', 'mkrB', 'mkrNope']) == {'mkrA': 1200, 'mkrB': 1300}
lags = lag.paint_lags(records, frames, chunk_at, ['mkrA', 'mkrB', 'mkrNope'])
assert round(lags['mkrA']) == 15 and round(lags['mkrB']) == 30 and 'mkrNope' not in lags, lags
summary = lag.summarize([15, 30, None])
assert summary['n'] == 2 and summary['missing'] == 1 and summary['p50'] == 22.5 and summary['max'] == 30, summary
assert abs(summary['p95'] - 29.25) < 1e-9, summary
marks = lag.spawn_marks(records, submit_ms=900)
assert marks == {'prewarmed': False, 'submit_to_spawn_ms': 90, 'spawn_to_prompt_ms': 110, 'submit_to_prompt_ms': 200}, marks
early = lag.spawn_marks(records, submit_ms=1050)
assert early['prewarmed'] is True and early['spawn_to_prompt_ms'] is None and early['submit_to_prompt_ms'] == 50, early
assert lag.last_vendor_ms(records) == 1400
assert lag.first_index(frames, chunk_at, 'mkrB') == 2
assert lag.first_index(frames, chunk_at, 'mkrA', not_before_ms=1300) == 2
print('lag arithmetic ok')
