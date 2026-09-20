#!/usr/bin/env node
/** What this terminal actually does with the things every ClikCode frame relies on.
 *
 * The renderer draws one frame per repaint and then walks the cursor back up
 * into the composer with RELATIVE motions. Every "the cursor is parked below
 * the composer" report is one of these assumptions failing, and which one
 * cannot be told apart from the outside. So ask the terminal.
 *
 * Run it in the terminal that misbehaves:  node terminal-probe.mjs
 */
import { stdin as input, stdout as output } from 'node:process';

const ESC = String.fromCharCode(27);
const CSI = `${ESC}[`;
const REPORT = new RegExp(`${ESC}\\[(\\d+);(\\d+)R`);
const results = [];

/** Write `sequence`, then ask the terminal where its cursor ended up. */
function ask(sequence = '') {
  return new Promise((resolve) => {
    let buffer = '';
    const finish = (value) => {
      clearTimeout(timer);
      input.off('data', onData);
      resolve(value);
    };
    const onData = (chunk) => {
      buffer += chunk.toString();
      const match = REPORT.exec(buffer);
      if (match) finish({ row: Number(match[1]), column: Number(match[2]) });
    };
    const timer = setTimeout(() => finish(undefined), 1500);
    input.on('data', onData);
    output.write(`${sequence}${CSI}6n`);
  });
}

const at = (position) => (position ? `${position.row},${position.column}` : 'no answer');

async function main() {
  if (!input.isTTY || !output.isTTY) {
    console.error('Run this in a real terminal: it asks the terminal where its cursor is.');
    process.exit(1);
  }
  input.setRawMode(true);
  input.resume();
  const columns = Math.max(1, output.columns ?? 80);
  results.push(`TERM=${process.env.TERM ?? '(unset)'}  TERM_PROGRAM=${process.env.TERM_PROGRAM ?? '(unset)'}  size=${output.columns}x${output.rows}`);

  // 1. Does a row that fills the last column wrap on its own?
  output.write('\n');
  const beforeFull = await ask();
  const afterFull = await ask('-'.repeat(columns));
  results.push(`full-width row, autowrap on:  ${at(beforeFull)} -> ${at(afterFull)}  ${afterFull && beforeFull && afterFull.row > beforeFull.row ? '*** WRAPS EAGERLY ***' : 'stays on its row'}`);

  // 2. Is DECAWM-off honoured? Every frame is written inside this mode.
  const beforeNoWrap = await ask(`\r${CSI}2K`);
  const afterNoWrap = await ask(`${CSI}?7l${'-'.repeat(columns)}${CSI}?7h`);
  results.push(`full-width row, DECAWM off:   ${at(beforeNoWrap)} -> ${at(afterNoWrap)}  ${afterNoWrap && beforeNoWrap && afterNoWrap.row > beforeNoWrap.row ? '*** MODE IGNORED ***' : 'honoured'}`);

  // 3. The motion that parks the cursor in the composer: write a block, walk
  //    back up inside it.
  const top = await ask(`\r${CSI}2K`);
  const parked = await ask(`row A\nrow B\nrow C\nrow D\r${CSI}2A${CSI}4C`);
  const expected = top ? top.row + 1 : undefined;
  results.push(`park 2 rows up in a 4-row block: expected ${expected},5  actual ${at(parked)}  ${parked && parked.row === expected ? 'OK' : `*** OFF BY ${parked && expected ? parked.row - expected : '?'} ***`}`);

  // 4. Unknown private modes must be swallowed, not printed as text.
  const syncBefore = await ask(`\r${CSI}2K`);
  const syncAfter = await ask(`${CSI}?2026h${CSI}?2026l`);
  results.push(`synchronized-update pair:     ${at(syncBefore)} -> ${at(syncAfter)}  ${syncBefore && syncAfter && syncBefore.column === syncAfter.column ? 'swallowed' : '*** PRINTED AS TEXT ***'}`);

  output.write(`\r${CSI}2K\n`);
  input.setRawMode(false);
  input.pause();
  console.log(`\n${results.join('\n')}\n`);
}

main().catch((error) => { console.error(error); process.exit(1); });
