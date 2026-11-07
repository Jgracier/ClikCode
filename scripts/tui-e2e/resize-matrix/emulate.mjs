#!/usr/bin/env node
/* Replays a recorded pty session into a real terminal emulator (@xterm/headless) and writes one snapshot per `snap`
 * event: the normal buffer's scrollback and screen, the cursor, and whether the alternate screen is up. The log is
 * JSON lines: {k:'out', d:<base64>} bytes the program wrote, {k:'resize', c, r} the window changing size (the emulator
 * is resized at the same point in the byte stream), {k:'snap', label}. Terminal variants (argv[3]):
 *   xterm        as it is
 *   xterm-no3j   a terminal that ignores CSI 3J (the saved lines survive a clear) and DEC 2026, as tmux/screen often do
 * Usage: emulate.mjs <events.jsonl> <snapshots.json> [variant] */
import { readFileSync, writeFileSync } from 'node:fs';
import xterm from '@xterm/headless';

const [, , input, output, variant = 'xterm'] = process.argv;
const events = readFileSync(input, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
const first = events.find((event) => event.k === 'resize');
const term = new xterm.Terminal({ cols: first.c, rows: first.r, scrollback: 100000, allowProposedApi: true });
const write = (data) => new Promise((resolve) => term.write(data, resolve));

function lines(buffer, from, to) {
  const rows = [];
  for (let index = from; index < to; index += 1) {
    const line = buffer.getLine(index);
    rows.push({ text: line ? line.translateToString(true) : '', wrapped: line ? line.isWrapped : false });
  }
  return rows;
}

const snaps = [];
let sized = false;
for (const event of events) {
  if (event.k === 'resize') {
    if (!sized) { sized = true; continue; }
    term.resize(event.c, event.r);
  } else if (event.k === 'out') {
    let data = Buffer.from(event.d, 'base64');
    if (variant === 'xterm-no3j') data = Buffer.from(data.toString('latin1').replaceAll('\u001b[3J', '').replaceAll('\u001b[?2026h', '').replaceAll('\u001b[?2026l', ''), 'latin1');
    await write(data);
  } else if (event.k === 'snap') {
    const normal = term.buffer.normal;
    const active = term.buffer.active;
    snaps.push({
      label: event.label, cols: term.cols, rows: term.rows, alt: active.type === 'alternate',
      scrollback: lines(normal, 0, normal.baseY), screen: lines(active, active.baseY, active.baseY + term.rows),
      cursor: { x: active.cursorX, y: active.cursorY },
    });
  }
}
writeFileSync(output, JSON.stringify(snaps));
