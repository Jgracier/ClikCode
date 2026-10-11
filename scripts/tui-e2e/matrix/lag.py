"""The lag arithmetic of the matrix rig, pure functions over a vendor-side
emission log (FAKE_EMIT_LOG records, `t` in ms from Date.now()) and the
runner's per-chunk record (frames of emulated screen text, `chunk_at` in
seconds from time.time() at the pty read). Both clocks are this machine's
wall clock, so a difference is a real interval.

Nothing here knows a harness: matrix.py hands it markers and phrases.
"""
import json, math

# Records that are the vendor writing an event to its pipe. `start` carries
# the prompt-free argv, `recv` the prompt arriving, `end` the turn's last byte.
EMIT_EVENTS = ('update', 'emit')


def marker_emit_times(records, markers, pid=None):
    """{marker: t_ms of the first vendor write that carries it}. A marker no
    write carries is absent (the fake never said it)."""
    found = {}
    for record in records:
        if record.get('ev') not in EMIT_EVENTS: continue
        if pid is not None and record.get('pid') != pid: continue
        body = None
        for marker in markers:
            if marker in found: continue
            if body is None: body = json.dumps(record, ensure_ascii=False)
            if marker in body: found[marker] = record['t']
    return found


def first_index(frames, chunk_at, phrase, not_before_ms=None, predicate=None):
    """Index of the first frame whose screen holds `phrase` (or satisfies
    `predicate(text)`), read at or after `not_before_ms`; None if none."""
    for index, (_, text) in enumerate(frames):
        if not_before_ms is not None and chunk_at[index] * 1000.0 < not_before_ms: continue
        if predicate(text) if predicate else phrase in text: return index
    return None


def paint_lags(records, frames, chunk_at, markers, pid=None):
    """{marker: ms from the vendor's write to the first frame holding it, or
    None when it never reached the screen}."""
    emitted = marker_emit_times(records, markers, pid)
    lags = {}
    for marker in markers:
        if marker not in emitted: continue
        at = first_index(frames, chunk_at, marker, not_before_ms=emitted[marker] - 5)
        # A frame cannot show what was not written yet; the 5 ms of slack
        # keeps a same-millisecond write from being skipped by rounding.
        lags[marker] = None if at is None else chunk_at[at] * 1000.0 - emitted[marker]
    return lags


def percentile(values, fraction):
    values = sorted(values)
    if not values: return None
    if len(values) == 1: return values[0]
    rank = (len(values) - 1) * fraction
    low, high = math.floor(rank), math.ceil(rank)
    return values[low] + (values[high] - values[low]) * (rank - low)


def summarize(values):
    """p50/p95/max over the events of a turn (None entries -- never painted --
    are not counted, but `missing` says how many there were)."""
    present = [value for value in values if value is not None]
    return {'n': len(present), 'missing': len(values) - len(present),
            'p50': percentile(present, 0.5), 'p95': percentile(present, 0.95), 'max': max(present) if present else None}


def turn_pid(records):
    """The vendor process that received the prompt, and its records."""
    for record in records:
        if record.get('ev') == 'recv': return record['pid']
    return None


def spawn_marks(records, submit_ms):
    """submit_to_spawn_ms, spawn_to_prompt_ms (and their sum) for the process
    that took the prompt. A process that began before the prompt was submitted
    was started ahead of it (`prewarmed`): its spawn-to-prompt time is then
    mostly idle waiting for the user, so it is not reported as handshake."""
    pid = turn_pid(records)
    if pid is None: return {'prewarmed': None, 'submit_to_spawn_ms': None, 'spawn_to_prompt_ms': None, 'submit_to_prompt_ms': None}
    started = next((r for r in records if r.get('ev') == 'start' and r.get('pid') == pid), None)
    prompt = next((r for r in records if r.get('ev') == 'recv' and r.get('pid') == pid), None)
    spawn = started['execAt'] if started else None
    prewarmed = spawn is not None and spawn < submit_ms
    return {
        'prewarmed': prewarmed,
        'submit_to_spawn_ms': None if spawn is None else spawn - submit_ms,
        'spawn_to_prompt_ms': None if spawn is None or prewarmed else prompt['t'] - spawn,
        'submit_to_prompt_ms': prompt['t'] - submit_ms,
    }


def last_vendor_ms(records, pid=None):
    """When the vendor wrote its last byte of the turn (an `end` record, else
    the last event written)."""
    times = [r['t'] for r in records if r.get('ev') in EMIT_EVENTS + ('end',) and (pid is None or r.get('pid') == pid)]
    return max(times) if times else None
