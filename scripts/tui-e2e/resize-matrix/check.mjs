#!/usr/bin/env node
/* Judges snapshots (emulate.mjs / matrix.py) against the layout invariants and prints one verdict per snapshot as JSON.
 * Usage: check.mjs <snapshots.json> <inline|full> */
import { readFileSync } from 'node:fs';

const [, , input, mode] = process.argv;
const snaps = JSON.parse(readFileSync(input, 'utf8'));
const MARKER = /\bH(\d{3})\b/;
const RULE = /^\s*─{10,}\s*$/;
const STATUS = /Grok Build|•.*•/;

/** The conversation as the snapshot shows it: from its first row to the row above the live block, blank rows above the first row (the screen's own) left out. */
function conversation(snap) {
  const all = [...snap.scrollback, ...snap.screen].map((row) => row.text);
  const first = all.findIndex((row) => row.trim() !== '');
  const status = all.findLastIndex((row) => STATUS.test(row));
  const rule = all.findLastIndex((row, index) => index < status && RULE.test(row));
  const block = rule > 0 ? all.findLastIndex((row, index) => index < rule && RULE.test(row)) : -1;
  let end = block > 0 ? block : all.length;
  while (end > first && all[end - 1].trim() === '') end -= 1;
  return all.slice(Math.max(0, first), end);
}

export function judge(snap, start) {
  const problems = [];
  const text = (row) => row.text;
  const screen = snap.screen.map(text);
  const scroll = snap.scrollback.map(text);
  const all = [...scroll, ...screen];
  const blank = (row) => row.trim() === '';
  const opts = snap.opts ?? {};
  // A modal surface is drawn on the alternate screen, in inline mode too; everything else, inline, is on the main screen.
  const wantAlt = !opts.afterExit && !snap.noAlt && (mode === 'full' || (opts.surface === 'page' && mode !== 'full'));
  if (snap.alt !== wantAlt) problems.push(`alternate screen is ${snap.alt ? 'up' : 'down'} in ${mode} mode${opts.surface === 'page' ? ' with a surface open' : ''}`);
  // The composer and status are the last rows of the screen: a rule, the composer, a rule, the status line.
  if (!opts.noBlock) {
    // The block owns its own rows and nothing else: whatever the terminal does when the screen changes height (pull saved
    // lines back or not, add blank rows below or not), the block is whole, the status line is its last row and only blank
    // rows are below it. A client that does not pull shows blank space below the composer; that is the client's.
    let last = screen.length - 1;
    while (last > 0 && blank(screen[last])) last -= 1;
    if (mode === 'full' && last !== screen.length - 1) problems.push(`blank band below the status line: it is row ${last + 1} of ${screen.length}`);
    if (blank(screen[last] ?? '') || !STATUS.test(screen[last] ?? '')) {
      const at = screen.findLastIndex((row) => STATUS.test(row));
      problems.push(`status line is not the last non-blank screen row (it is row ${at + 1} of ${screen.length}; the last is ${JSON.stringify(screen[last])})`);
    }
    else if (!RULE.test(screen[last - 1] ?? '') && !/^\s*›/.test(screen[last - 1] ?? '') && !RULE.test(screen[last - 2] ?? '')) problems.push('composer rules do not sit above the status line');
    const statuses = all.filter((row) => STATUS.test(row) && !MARKER.test(row)).length;
    if (statuses !== 1) problems.push(`${statuses} status lines on screen and in scrollback (a stale block)`);
    const composers = all.filter((row) => /^\s*›(\s|$)/.test(row) && !/^\s*› (go|again|more)/.test(row)).length;
    if (composers > 1) problems.push(`${composers} empty composer rows (a stale block)`);
    // The caret is on the composer row.
    const composerRow = screen.findLastIndex((row) => /^\s*›/.test(row));
    if (composerRow >= 0 && snap.cursor.y !== composerRow && !opts.cursorAnywhere) problems.push(`cursor is on row ${snap.cursor.y + 1}, the composer is on row ${composerRow + 1}`);
  }
  // A modal surface (the board, the palette) is drawn on the alternate screen: it is the whole screen, no row of the conversation
  // shares it and no saved line exists behind it; the list starts on the first row, the composer and status are the last rows.
  // The main screen is not touched while it is up: its saved lines and visible rows are byte-for-byte what they were before it
  // opened (`keeps`), unless the screen changed size, which the client answers with its own rows.
  if (opts.surface === 'page' && mode !== 'full') {
    const chat = screen.findIndex((row) => MARKER.test(row));
    if (chat >= 0) problems.push(`a row of the conversation shares the screen with the surface (row ${chat + 1}: ${JSON.stringify(screen[chat])})`);
    if (blank(screen[0] ?? '')) problems.push('the surface does not start on the first row');
    if (!STATUS.test(screen[screen.length - 1] ?? '')) problems.push(`the status line is not the last row (${JSON.stringify(screen[screen.length - 1])})`);
    if (!screen.some((row) => /^\s*›/.test(row))) problems.push('no composer on the surface');
    if (opts.keeps && start && snap.mainScreen && start.mainScreen) {
      const was = [...start.scrollback, ...start.mainScreen].map(text);
      const now = [...snap.scrollback, ...snap.mainScreen].map(text);
      const at = was.findIndex((row, index) => row !== now[index]);
      if (at >= 0 || was.length !== now.length) problems.push(`the main screen changed while the surface was open: ${was.length} rows (saved lines and screen) then, ${now.length} now, first difference at row ${at + 1} (${JSON.stringify(was[at])} then, ${JSON.stringify(now[at])} now)`);
    }
  }
  // Blank rows: only above the first content row, and only on the screen (never pushed into scrollback).
  const firstContent = all.findIndex((row) => !blank(row));
  if (!opts.leading && firstContent > 0 && firstContent <= scroll.length) problems.push(`${firstContent} blank row(s) at the top of the scrollback`);
  let run = 0;
  let worst = 0;
  let worstAt = -1;
  for (let index = Math.max(0, firstContent); index < all.length; index += 1) {
    if (blank(all[index])) { run += 1; if (run > worst) { worst = run; worstAt = index; } } else run = 0;
  }
  // The blanks the block itself opens with (the transcript's closing blank and the block's own) are not a gap.
  const statusAt = all.findLastIndex((row) => STATUS.test(row));
  let lastContent = statusAt >= 3 ? statusAt - 3 : all.findLastIndex((row) => !blank(row));
  while (lastContent > 0 && blank(all[lastContent - 1])) lastContent -= 1;
  lastContent -= 1;
  // Trailing blanks after the last content are a block that is not at the bottom (reported above), not a gap.
  if (!opts.board && !opts.turns && worst >= 2 && worstAt <= lastContent) problems.push(`a run of ${worst} blank rows inside the conversation (ending at row ${worstAt + 1} of ${all.length}, ${worstAt < scroll.length ? 'in scrollback' : 'on screen'})`);
  // History markers: each once, in order, none missing, for the ones the scenario has had printed.
  if (opts.shows) for (const n of opts.shows) if (!screen.some((row) => new RegExp(`\\bH${String(n).padStart(3, '0')}\\b`).test(row))) problems.push(`H${String(n).padStart(3, '0')} is not on screen`);
  if (opts.afterExit) {
    // The program has ended: the normal screen and its scrollback hold the conversation once, in order, then the shell's own rows;
    // nothing of the program's screen (status line, composer rules) is left.
    if (all.some((row) => STATUS.test(row) && !MARKER.test(row)) || all.some((row) => RULE.test(row))) problems.push('a row of the program\'s own screen (status line or composer rule) is left after exit');
  }
  if (!opts.noHistory && snap.expectMarkers && mode === 'full' && !opts.afterExit) {
    // Full-screen: the viewport shows the newest rows, the older ones are scrolled back. The newest is shown, and what is shown has no hole.
    const seen = (snap.alt ? screen : all).map((row) => MARKER.exec(row)).filter(Boolean).map((match) => Number(match[1]));
    if (opts.covered || opts.scrolledBack) { if (opts.scrolledBack && seen.length && Math.max(...seen) === snap.expectMarkers[1]) problems.push('scrolled back, but the newest row is still on screen'); } else if (!seen.length || Math.max(...seen) !== snap.expectMarkers[1]) problems.push(`the newest history row H${snap.expectMarkers[1]} is not on screen`);
    if (!opts.turns && seen.some((value, index) => index > 0 && value !== seen[index - 1] + 1)) problems.push('a hole in the history shown');
  } else if (!opts.noHistory && snap.expectMarkers) {
    const seen = [];
    for (const row of all) { const match = MARKER.exec(row); if (match) seen.push(Number(match[1])); }
    const unique = [...new Set(seen)];
    const duplicated = unique.filter((marker) => seen.filter((x) => x === marker).length > 1);
    if (duplicated.length) problems.push(`history rows repeated: ${duplicated.slice(0, 6).map((n) => `H${String(n).padStart(3, '0')}`).join(' ')}`);
    const missing = [];
    for (let n = snap.expectMarkers[0]; n <= snap.expectMarkers[1]; n += 1) if (!seen.includes(n)) missing.push(n);
    if (missing.length) problems.push(`history lost: ${missing.slice(0, 6).map((n) => `H${String(n).padStart(3, '0')}`).join(' ')}${missing.length > 6 ? ` ... (${missing.length})` : ''}`);
    const ordered = seen.every((value, index) => index === 0 || value >= seen[index - 1]);
    if (!ordered) problems.push('history rows out of order');
  }
  // The conversation is what it was: every row, blank rows between turns included, in place.
  if (mode !== 'full' && opts.sameAs && start && start !== snap) {
    const was = conversation(start);
    const now = conversation(snap);
    const at = was.findIndex((row, index) => row !== now[index]);
    if (at >= 0 || was.length !== now.length) problems.push(`the conversation is not what it was at "${opts.sameAs}": ${was.length} rows then, ${now.length} now, first difference at row ${at + 1} (${JSON.stringify(was[at])} then, ${JSON.stringify(now[at])} now)`);
  }
  // What the program wrote since the last snapshot (a change of height alone, inline: the alternate screen draws its own rows): bounded by the live block, no history row among it.
  if (mode !== 'full' && opts.maxBytes !== undefined && snap.bytes !== undefined && snap.bytes > opts.maxBytes) problems.push(`${snap.bytes} bytes written, more than ${opts.maxBytes}`);
  if (mode !== 'full' && opts.maxHistoryRows !== undefined && snap.historyRows !== undefined && snap.historyRows > opts.maxHistoryRows) problems.push(`${snap.historyRows} history row(s) written again`);
  // Nothing wrapped: every row is drawn to fit the width.
  if (!opts.allowWrap) {
    const wrapped = [...snap.scrollback, ...snap.screen].filter((row) => row.wrapped).length;
    if (wrapped) problems.push(`${wrapped} wrapped row(s): a row is wider than the screen`);
  }
  return problems;
}

const verdicts = snaps.map((snap) => ({ label: snap.label, size: `${snap.cols}x${snap.rows}`, problems: judge(snap, snaps.find((other) => other.label === (snap.opts?.sameAs ?? snap.opts?.keeps))) }));
console.log(JSON.stringify(verdicts));
