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
 *   xterm-no3j   a terminal that ignores CSI 3J (the saved lines survive a clear) and DEC 2026, as tmux/screen often do

 *   xterm-keepback a client that never erases anything from the main screen's history: CSI 3J is ignored AND so is CSI 2J while the main screen
 *                  is up (what a client that keeps a copy of every cleared screen does). A page that drew on the main screen after a clear
 *                  would leave rows of the conversation directly above it, wherever the viewport is scrolled to.
 *   xterm-nopull a client that does not pull saved lines back when the window grows: the content stays top-aligned, blank rows appear below
 *   xterm-mute   a terminal that never answers a cursor position request (CSI 6n): the program's defined failure is exercised */
import { createInterface } from 'node:readline';
import xterm from '@xterm/headless';

const variant = process.argv[2] ?? 'xterm';
let term;
const snaps = [];
let bytes = 0;
let historyRows = 0;
const stash = [];
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
  } else if (event.k === 'resize') {
    if (variant === 'xterm-nopull' && event.r > term.rows) {
      // A client that keeps its content top-aligned when the window grows and adds blank rows below it: the saved lines stay
      // where they are (kept here, ahead of the terminal's own) and are not pulled back in.
      const normal = term.buffer.normal;
      stash.push(...lines(normal, 0, normal.baseY));
      term.options.scrollback = 0;
      term.options.scrollback = 100000;
    }
    term.resize(event.c, event.r);
  } else if (event.k === 'out') {
    let data = Buffer.from(event.d, 'base64');
    bytes += data.length;
    if (variant === 'xterm-nopull' && data.includes('\u001b[3J')) stash.length = 0;
    historyRows += (data.toString('latin1').replace(ESCAPES, '').match(/\bH\d{3}\b/g) ?? []).length;
    if (variant === 'xterm-keepback') {
      // Row-wise: 2J is kept only while the alternate screen is up (the alternate screen has no history to keep).
      const parts = data.toString('latin1').replaceAll('\u001b[3J', '').split(/(\u001b\[\?1049[hl])/);
      let alt = term.buffer.active.type === 'alternate';
      let out = '';
      for (const part of parts) {
        if (part === '\u001b[?1049h') alt = true; else if (part === '\u001b[?1049l') alt = false;
        out += alt || part.startsWith('\u001b[?1049') ? part : part.replaceAll('\u001b[2J', '');
      }
      data = Buffer.from(out.replaceAll('\u001b[?2026h', '').replaceAll('\u001b[?2026l', ''), 'latin1');
    }
    if (variant === 'xterm-no3j') data = Buffer.from(data.toString('latin1').replaceAll('\u001b[3J', '').replaceAll('\u001b[?2026h', '').replaceAll('\u001b[?2026l', ''), 'latin1');
    if (variant === 'xterm-mute') data = Buffer.from(data.toString('latin1').replaceAll('\u001b[6n', ''), 'latin1');
    await write(data);
  } else if (event.k === 'snap') {
    const normal = term.buffer.normal;
    const active = term.buffer.active;
    snaps.push({
      label: event.label, cols: term.cols, rows: term.rows, alt: active.type === 'alternate', bytes, historyRows,
      scrollback: [...stash, ...lines(normal, 0, normal.baseY)], screen: lines(active, active.baseY, active.baseY + term.rows),
      mainScreen: lines(normal, normal.baseY, normal.baseY + term.rows),
      cursor: { x: active.cursorX, y: active.cursorY },
    });
    bytes = 0;
    historyRows = 0;
  } else if (event.k === 'end') {
    process.stdout.write(`${JSON.stringify({ k: 'snaps', snaps })}\n`, () => process.exit(0));
  }
}));
