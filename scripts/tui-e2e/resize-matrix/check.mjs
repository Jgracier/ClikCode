#!/usr/bin/env node
/* Judges snapshots (emulate.mjs / matrix.py) against the layout invariants and prints one verdict per snapshot as JSON.
 * Usage: check.mjs <snapshots.json> <inline|full> */
import { readFileSync } from 'node:fs';

const [, , input, mode] = process.argv;
const snaps = JSON.parse(readFileSync(input, 'utf8'));
const MARKER = /\bH(\d{3})\b/;
const RULE = /^\s*─{10,}\s*$/;
const STATUS = /Grok Build|•.*•/;

export function judge(snap) {
  const problems = [];
  const text = (row) => row.text;
  const screen = snap.screen.map(text);
  const scroll = snap.scrollback.map(text);
  const all = [...scroll, ...screen];
  const blank = (row) => row.trim() === '';
  const opts = snap.opts ?? {};
  if (snap.alt !== (mode === 'full')) problems.push(`alternate screen is ${snap.alt ? 'up' : 'down'} in ${mode} mode`);
  // The composer and status are the last rows of the screen: a rule, the composer, a rule, the status line.
  if (!opts.noBlock) {
    const last = screen.length - 1;
    if (blank(screen[last] ?? '') || !STATUS.test(screen[last] ?? '')) {
      const at = screen.findLastIndex((row) => STATUS.test(row));
      problems.push(`status line is not the last screen row (it is row ${at + 1} of ${screen.length}; the last is ${JSON.stringify(screen[last])})`);
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
  // Blank rows: only above the first content row, and only on the screen (never pushed into scrollback).
  const firstContent = all.findIndex((row) => !blank(row));
  if (firstContent > 0 && firstContent <= scroll.length) problems.push(`${firstContent} blank row(s) at the top of the scrollback`);
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
  if (!opts.board && worst >= 2 && worstAt <= lastContent) problems.push(`a run of ${worst} blank rows inside the conversation (ending at row ${worstAt + 1} of ${all.length}, ${worstAt < scroll.length ? 'in scrollback' : 'on screen'})`);
  // History markers: each once, in order, none missing, for the ones the scenario has had printed.
  if (!opts.noHistory && snap.expectMarkers && mode === 'full') {
    // Full-screen: the viewport shows the newest rows, the older ones are scrolled back. The newest is shown, and what is shown has no hole.
    const seen = all.map((row) => MARKER.exec(row)).filter(Boolean).map((match) => Number(match[1]));
    if (opts.covered) { /* an open list covers the rows just above the composer by design */ } else if (!seen.length || Math.max(...seen) !== snap.expectMarkers[1]) problems.push(`the newest history row H${snap.expectMarkers[1]} is not on screen`);
    else if (seen.some((value, index) => index > 0 && value !== seen[index - 1] + 1)) problems.push('a hole in the history shown');
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
  // Nothing wrapped: every row is drawn to fit the width.
  if (!opts.allowWrap) {
    const wrapped = [...snap.scrollback, ...snap.screen].filter((row) => row.wrapped).length;
    if (wrapped) problems.push(`${wrapped} wrapped row(s): a row is wider than the screen`);
  }
  return problems;
}

const verdicts = snaps.map((snap) => ({ label: snap.label, size: `${snap.cols}x${snap.rows}`, problems: judge(snap) }));
console.log(JSON.stringify(verdicts));
