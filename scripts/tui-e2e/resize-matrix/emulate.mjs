#!/usr/bin/env node
/* A live terminal emulator (@xterm/headless) the matrix drives over pipes. The program under test runs in a real pty;
 * matrix.py copies every byte the pty gives to this process and writes back whatever the terminal answers (a cursor
 * position report is a question the program asks and waits for). One JSON object per line on stdin:
 *   {k:'init', c, r}   the window's first size
 *   {k:'out', d}       base64 bytes the program wrote
 *   {k:'resize', c, r} the window changing size, at this point in the byte stream
 *   {k:'snap', label}  record the normal buffer's scrollback and screen, the cursor, whether the alternate screen is up,
 *                      the bytes the program wrote and the history rows (H000 markers) among them since the last snap
 *   {k:'end'}          write {k:'snaps', snaps} and exit
 * and on stdout {k:'reply', d} for every answer the terminal gives. Terminal variants (argv[2]):
 *   xterm        as it is
 *   xterm-no3j   a terminal that ignores CSI 3J (the saved lines survive a clear) and DEC 2026, as tmux/screen often do */
import { createInterface } from 'node:readline';
import xterm from '@xterm/headless';

const variant = process.argv[2] ?? 'xterm';
let term;
const snaps = [];
let bytes = 0;
let historyRows = 0;
const write = (data) => new Promise((resolve) => term.write(data, resolve));

function lines(buffer, from, to) {
  const rows = [];
  for (let index = from; index < to; index += 1) {
    const line = buffer.getLine(index);
    rows.push({ text: line ? line.translateToString(true) : '', wrapped: line ? line.isWrapped : false });
  }
  return rows;
}

/* eslint-disable-next-line no-control-regex */
const ESCAPES = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007|\u001b[()][A-Za-z0-9]/g;
const chain = (() => { let last = Promise.resolve(); return (job) => { last = last.then(job); return last; }; })();
const lineReader = createInterface({ input: process.stdin });
lineReader.on('line', (line) => chain(async () => {
  if (!line) return;
  const event = JSON.parse(line);
  if (event.k === 'init') {
    term = new xterm.Terminal({ cols: event.c, rows: event.r, scrollback: 100000, allowProposedApi: true });
    term.onData((data) => process.stdout.write(`${JSON.stringify({ k: 'reply', d: Buffer.from(data).toString('base64') })}\n`));
  } else if (event.k === 'resize') term.resize(event.c, event.r);
  else if (event.k === 'out') {
    let data = Buffer.from(event.d, 'base64');
    bytes += data.length;
    historyRows += (data.toString('latin1').replace(ESCAPES, '').match(/\bH\d{3}\b/g) ?? []).length;
    if (variant === 'xterm-no3j') data = Buffer.from(data.toString('latin1').replaceAll('\u001b[3J', '').replaceAll('\u001b[?2026h', '').replaceAll('\u001b[?2026l', ''), 'latin1');
    await write(data);
  } else if (event.k === 'snap') {
    const normal = term.buffer.normal;
    const active = term.buffer.active;
    snaps.push({
      label: event.label, cols: term.cols, rows: term.rows, alt: active.type === 'alternate', bytes, historyRows,
      scrollback: lines(normal, 0, normal.baseY), screen: lines(active, active.baseY, active.baseY + term.rows),
      cursor: { x: active.cursorX, y: active.cursorY },
    });
    bytes = 0;
    historyRows = 0;
  } else if (event.k === 'end') {
    process.stdout.write(`${JSON.stringify({ k: 'snaps', snaps })}\n`, () => process.exit(0));
  }
}));
