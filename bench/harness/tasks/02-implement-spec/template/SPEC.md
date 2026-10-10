# Durations

## `src/units.ts`

Exports `UNIT_MS`: a record from unit suffix to its length in milliseconds.

| unit | milliseconds |
| ---- | ------------ |
| `w`  | 604800000    |
| `d`  | 86400000     |
| `h`  | 3600000      |
| `m`  | 60000        |
| `s`  | 1000         |
| `ms` | 1            |

## `src/duration.ts`

### `parseDuration(text: string): number`

`text` is one or more `<integer><unit>` parts with no separators between them,
for example `90s`, `1h30m`, `2d4h`, `250ms`, `1m500ms`. Whitespace around the
whole string is ignored. Returns the total in milliseconds.

The units must appear in strictly decreasing size, each at most once: `30m1h`
and `1h1h` are invalid.

Anything invalid throws a `RangeError` whose message contains the original
text: the empty string, an unknown unit (`5y`), a part without a number (`h`),
a decimal (`1.5h`), a negative number (`-5s`), or a number with no unit (`42`).

### `formatDuration(ms: number): string`

The inverse: the largest units first, zero parts left out, for example
`5400000` -> `1h30m`, `1500` -> `1s500ms`, `0` -> `0ms`. A negative or
non-integer `ms` throws a `RangeError`.

`parseDuration(formatDuration(x)) === x` for every non-negative integer `x`.

### Rule

Both functions take their conversion factors from `UNIT_MS`; `duration.ts`
contains no millisecond constants of its own.
