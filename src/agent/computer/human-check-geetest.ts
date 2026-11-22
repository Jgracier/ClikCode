/** GeeTest v4. Its challenges are drawn in the page itself, and most give everything needed in the markup: the
 * jigsaw slider is solved by pixels, the board games by rule, and only the icon challenges ask the models. */
import type { Page } from 'playwright-core';
import { toTarget, visitorClick, visitorDrag, type Asks, type Box, type Hands } from './human-check-hands.js';
import { fetchAsTab } from './tab-fetch.js';
import { quiet } from '../../runtime/lifecycle-log.js';

/** Where a jigsaw piece fits in its background, by pixels, not by asking a model: the piece's outline (from its
 * transparency) is slid across the background's edge map at the piece's own height, and the offset where the most
 * edges line up is the gap. Runs in a blank tab so no site rule or tainted canvas gets in the way. Returns the
 * gap's left edge in displayed pixels, or undefined. */
async function gapOffset(page: Page, background: Buffer, piece: Buffer, shown: { width: number; height: number; pieceWidth: number; pieceHeight: number; pieceTop: number }): Promise<number | undefined> {
  const blank = await page.context().newPage();
  try {
    const script = `(async () => {
      const [BG, PIECE, S] = ${JSON.stringify(['data:image/png;base64,' + background.toString('base64'), 'data:image/png;base64,' + piece.toString('base64'), shown])};
      const load = src => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('image')); i.src = src; });
      const [bg, pc] = await Promise.all([load(BG), load(PIECE)]);
      const W = Math.round(S.width), H = Math.round(S.height), pw = Math.round(S.pieceWidth), ph = Math.round(S.pieceHeight), top = Math.round(S.pieceTop);
      const draw = (img, w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d'); x.drawImage(img, 0, 0, w, h); return x.getImageData(0, 0, w, h).data; };
      const b = draw(bg, W, H), p = draw(pc, pw, ph);
      const gray = new Float32Array(W * H);
      for (let i = 0; i < W * H; i++) gray[i] = 0.299 * b[i * 4] + 0.587 * b[i * 4 + 1] + 0.114 * b[i * 4 + 2];
      const grad = new Float32Array(W * H);
      for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) grad[y * W + x] = Math.abs(gray[y * W + x + 1] - gray[y * W + x - 1]) + Math.abs(gray[(y + 1) * W + x] - gray[(y - 1) * W + x]);
      const solid = (x, y) => x >= 0 && y >= 0 && x < pw && y < ph && p[(y * pw + x) * 4 + 3] > 128;
      const edge = [];
      for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) if (solid(x, y) && !(solid(x - 1, y) && solid(x + 1, y) && solid(x, y - 1) && solid(x, y + 1))) edge.push([x, y]);
      if (edge.length < 20) return null;
      let best = -1, bestScore = -1, second = -1;
      for (let x0 = Math.round(pw * 0.6); x0 <= W - pw; x0++) {
        let score = 0;
        for (const [ex, ey] of edge) { const y = ey + top; if (y > 0 && y < H) score += Math.min(grad[y * W + ex + x0], 120); }
        if (score > bestScore) { second = bestScore; bestScore = score; best = x0; } else if (score > second) second = score;
      }
      return best < 0 ? null : best;
    })()`;
    const found = await blank.evaluate(script).catch(() => null) as number | null;
    return typeof found === 'number' ? found : undefined;
  } finally { await blank.close().catch(quiet('agent/computer/human-check-geetest')); }
}

/** GeeTest's jigsaw slider: both pictures are fetched, the gap is found by pixels, and the handle is dragged so
 * the piece lands on it. */
async function solveGeetestSlide(page: Page, random: () => number, sleep: (ms: number) => Promise<void>, trace?: (line: string) => void): Promise<boolean> {
  const info = await page.evaluate(`(() => {
    const pick = sel => Array.from(document.querySelectorAll(sel)).find(e => { const r = e.getBoundingClientRect(); return r.width > 10 && r.height > 10 && r.bottom > 0 && r.top < innerHeight; });
    const named = name => Array.from(document.querySelectorAll('[class*="' + name + '"]')).find(e => { const r = e.getBoundingClientRect(); return r.width > 10 && r.height > 10 && r.bottom > 0 && r.top < innerHeight && String(e.className).split(/\\s+/).some(c => c === name || new RegExp('^' + name + '_[0-9a-f]{6,}$').test(c)); });
    const bg = named('geetest_bg'), slice = named('geetest_slice_bg') || named('geetest_slice'), btn = named('geetest_btn');
    if (!bg || !slice || !btn) return null;
    const url = e => { const m = /url\\(["']?([^"')]+)["']?\\)/.exec(getComputedStyle(e).backgroundImage); return m ? m[1] : ''; };
    const r = e => { const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; };
    return { bgUrl: url(bg), sliceUrl: url(slice), bg: r(bg), slice: r(slice), btn: r(btn) };
  })()`).catch(() => null) as { bgUrl: string; sliceUrl: string; bg: Box; slice: Box; btn: Box } | null;
  if (!info || !info.bgUrl || !info.sliceUrl) return false;
  let background: Buffer, piece: Buffer;
  try {
    const [a, b] = await Promise.all([fetchAsTab(page, info.bgUrl, { timeoutMs: 10_000 }), fetchAsTab(page, info.sliceUrl, { timeoutMs: 10_000 })]);
    if (!a.ok || !b.ok) return false;
    background = a.body; piece = b.body;
  } catch { return false; }
  const gap = await gapOffset(page, background, piece, { width: info.bg.width, height: info.bg.height, pieceWidth: info.slice.width, pieceHeight: info.slice.height, pieceTop: info.slice.y - info.bg.y });
  if (gap === undefined) return false;
  const distance = gap - (info.slice.x - info.bg.x);
  if (!(distance > 4)) return false;
  trace?.(`GeeTest slide: the gap is ${Math.round(gap)}px in, dragging ${Math.round(distance)}px`);
  const start = { x: info.btn.x + info.btn.width / 2, y: info.btn.y + info.btn.height / 2 };
  await visitorDrag(page.mouse, start, { x: start.x + distance, y: start.y }, random, sleep, 0);
  return true;
}

/** A board cell as the page lays it out: where it is, and which picture (if any) sits on it. */
export interface BoardCell { row: number; column: number; kind: string | null }

/** Gobang ("move one piece to line up five"): the piece to move and the empty cell to move it to, so that a row,
 * column or diagonal of the board holds the same picture in every cell. Undefined when no single move does it. */
export function lineUpMove(cells: BoardCell[]): { from: BoardCell; to: BoardCell } | undefined {
  const size = Math.max(...cells.map(c => Math.max(c.row, c.column))) + 1;
  const at = (row: number, column: number) => cells.find(c => c.row === row && c.column === column);
  const lines: BoardCell[][] = [];
  for (let i = 0; i < size; i++) {
    lines.push(cells.filter(c => c.row === i).sort((a, b) => a.column - b.column), cells.filter(c => c.column === i).sort((a, b) => a.row - b.row));
  }
  lines.push(Array.from({ length: size }, (_, i) => at(i, i)).filter((c): c is BoardCell => !!c), Array.from({ length: size }, (_, i) => at(i, size - 1 - i)).filter((c): c is BoardCell => !!c));
  for (const line of lines.filter(l => l.length === size)) {
    const empty = line.filter(c => c.kind === null);
    const kinds = new Set(line.filter(c => c.kind !== null).map(c => c.kind));
    if (empty.length !== 1 || kinds.size !== 1) continue;
    const kind = [...kinds][0]!;
    const from = cells.find(c => c.kind === kind && !line.includes(c));
    if (from) return { from, to: empty[0]! };
  }
  return undefined;
}

/** IconCrush ("swap two to line up three"): the two neighbouring cells to swap so a whole row or column matches. */
export function swapMove(cells: BoardCell[]): { from: BoardCell; to: BoardCell } | undefined {
  const size = Math.max(...cells.map(c => Math.max(c.row, c.column))) + 1;
  const wins = (board: BoardCell[]) => Array.from({ length: size }, (_, i) => i).some(i =>
    new Set(board.filter(c => c.row === i).map(c => c.kind)).size === 1 || new Set(board.filter(c => c.column === i).map(c => c.kind)).size === 1);
  for (const a of cells) for (const b of cells) {
    if (!(a.row === b.row && b.column === a.column + 1) && !(a.column === b.column && b.row === a.row + 1)) continue;
    if (a.kind === b.kind) continue;
    const swapped = cells.map(c => c === a ? { ...c, kind: b.kind } : c === b ? { ...c, kind: a.kind } : c);
    if (wins(swapped)) return { from: a, to: b };
  }
  return undefined;
}

/** GeeTest's board games (Gobang, IconCrush): every cell and its picture are in the page, so the move is worked
 * out by rule and played with two clicks -- no model involved. */
async function solveGeetestBoard(page: Page, random: () => number, sleep: (ms: number) => Promise<void>, trace?: (line: string) => void): Promise<boolean> {
  const read = await page.evaluate(`(() => {
    const shown = e => { const r = e.getBoundingClientRect(); return r.width > 10 && r.height > 10 && r.bottom > 0 && r.top < innerHeight; };
    const game = Array.from(document.querySelectorAll('[class*="geetest_winlinze"], [class*="geetest_match"]')).find(shown);
    if (!game) return null;
    const mode = /geetest_winlinze/.test(String(game.className)) ? 'lineup' : 'swap';
    const url = e => { const m = /url\\(["']?([^"')]+)["']?\\)/.exec(getComputedStyle(e).backgroundImage); return m ? m[1] : null; };
    const token = mode === 'lineup' ? /^geetest_item-\\d+-\\d+(?:_[0-9a-f]{6,})?$/ : /^geetest_img-\\d+(?:_[0-9a-f]{6,})?$/;
    const cells = Array.from(game.querySelectorAll('[class*="geetest_item-"], [class*="geetest_img-"]')).filter(e => shown(e) && String(e.className).split(/\\s+/).some(c => token.test(c)))
      .map(e => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, kind: /geetest_isEmpty/.test(String(e.className)) ? null : url(e) }; });
    return { mode, cells };
  })()`).catch(() => null) as { mode: 'lineup' | 'swap'; cells: Array<{ x: number; y: number; kind: string | null }> } | null;
  if (!read || read.cells.length < 9) return false;
  // Rows and columns come from where the cells sit, not from their names (the two games number them differently).
  const rank = (values: number[]) => { const sorted = [...new Set(values.map(v => Math.round(v / 8)))].sort((a, b) => a - b); return (v: number) => sorted.indexOf(Math.round(v / 8)); };
  const rowOf = rank(read.cells.map(c => c.y)), columnOf = rank(read.cells.map(c => c.x));
  const placed = read.cells.map(c => ({ ...c, row: rowOf(c.y), column: columnOf(c.x) }));
  const move = read.mode === 'lineup' ? lineUpMove(placed) : swapMove(placed);
  if (!move) { trace?.(`GeeTest board (${read.mode}): no winning move found`); return false; }
  trace?.(`GeeTest board (${read.mode}): moving row ${move.from.row + 1} column ${move.from.column + 1} to row ${move.to.row + 1} column ${move.to.column + 1}`);
  const from = placed.find(c => c.row === move.from.row && c.column === move.from.column)!, to = placed.find(c => c.row === move.to.row && c.column === move.to.column)!;
  // Both games are played with two clicks: the piece, then where it goes.
  const spot = (c: { x: number; y: number }) => ({ x: c.x - 6, x2: c.x + 6, y: c.y - 6, y2: c.y + 6 });
  await visitorClick(page.mouse, spot(from), random, sleep);
  await sleep(250 + random() * 300);
  await visitorClick(page.mouse, spot(to), random, sleep);
  return true;
}

/** GeeTest's "select in this order": small example icons and a picture holding a rough drawing of each. A picture
 * of the whole challenge goes to the voting models, the spots they agree on are clicked in order, then the confirm
 * button. With no agreement nothing is clicked and another challenge is asked for. */
async function solveGeetestIcons(page: Page, ordered: Asks['ordered'], random: () => number, sleep: (ms: number) => Promise<void>, trace?: (line: string) => void): Promise<boolean> {
  const info = await page.evaluate(`(() => {
    const shown = e => { const r = e.getBoundingClientRect(); return r.width > 10 && r.height > 10 && r.bottom > 0 && r.top < innerHeight; };
    const game = Array.from(document.querySelectorAll('[class*="geetest_click"]')).find(e => shown(e) && /geetest_subitem/.test(String(e.className)));
    const asks = Array.from(document.querySelectorAll('[class*="geetest_ques_back"] img, [class*="geetest_ques_tips"] img')).map(i => i.src).filter(Boolean);
    const bg = Array.from(document.querySelectorAll('[class*="geetest_bg"]')).find(shown);
    const submit = Array.from(document.querySelectorAll('[class*="geetest_submit"]')).find(shown);
    const box = Array.from(document.querySelectorAll('[class*="geetest_box"]')).find(shown);
    if (!game || !bg || !box || !asks.length) return null;
    const r = e => { const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; };
    return { count: new Set(asks).size, box: r(box), submit: submit ? r(submit) : null };
  })()`).catch(() => null) as { count: number; box: Box; submit: Box | null } | null;
  if (!info) return false;
  let picture: Buffer;
  try { picture = await page.screenshot({ type: 'png', clip: info.box, timeout: 8_000 }); } catch { return false; }
  const spots = await ordered({ mimeType: 'image/png', data: picture.toString('base64') });
  if (!spots || spots.length !== info.count) {
    trace?.(`GeeTest icons: no agreed answer for ${info.count} symbols, asking for another`);
    return refreshGeetest(page, random, sleep);
  }
  trace?.(`GeeTest icons: clicking ${spots.map(p => `(${p.x.toFixed(2)},${p.y.toFixed(2)})`).join(' then ')}`);
  for (const p of spots) {
    const x = info.box.x + p.x * info.box.width, y = info.box.y + p.y * info.box.height;
    await visitorClick(page.mouse, { x: x - 4, x2: x + 4, y: y - 4, y2: y + 4 }, random, sleep);
  }
  await sleep(400);
  if (info.submit) await visitorClick(page.mouse, toTarget(info.submit), random, sleep);
  return true;
}

/** Ask GeeTest for another challenge (its refresh button), for when the shown one could not be answered. */
async function refreshGeetest(page: Page, random: () => number, sleep: (ms: number) => Promise<void>): Promise<boolean> {
  const refresh = await page.evaluate(`(() => { const b = Array.from(document.querySelectorAll('[class*="geetest_refresh"]')).find(e => { const r = e.getBoundingClientRect(); return r.width > 8 && r.width < 60 && r.bottom > 0 && r.top < innerHeight; }); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`).catch(() => null) as Box | null;
  if (!refresh) return false;
  await visitorClick(page.mouse, toTarget(refresh), random, sleep);
  await sleep(2_500);
  return true;
}

/** GeeTest hands out its example picture tiny (48px) and speckled with noise, which the models read badly. The
 * speckle is taken out (each pixel becomes the median of its neighbourhood) and the picture enlarged, in a blank
 * tab so no site rule gets in the way. The picture as given comes back when that cannot be done. */
export async function cleanPicture(page: Page, picture: Buffer, mimeType: string): Promise<{ mimeType: string; data: string }> {
  const given = { mimeType, data: picture.toString('base64') };
  const blank = await page.context().newPage().catch(quiet('agent/computer/human-check-geetest'));
  if (!blank) return given;
  try {
    const cleaned = await blank.evaluate(`(async () => {
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('image')); i.src = ${JSON.stringify(`data:${mimeType};base64,${given.data}`)}; });
      const W = img.naturalWidth, H = img.naturalHeight;
      if (!W || !H || W > 200 || H > 200) return null;
      const c = document.createElement('canvas'); c.width = W; c.height = H;
      const x = c.getContext('2d'); x.drawImage(img, 0, 0);
      const from = x.getImageData(0, 0, W, H), to = x.createImageData(W, H);
      const window = [];
      for (let y = 0; y < H; y++) for (let px = 0; px < W; px++) for (let ch = 0; ch < 4; ch++) {
        if (ch === 3) { to.data[(y * W + px) * 4 + 3] = 255; continue; }
        window.length = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const yy = Math.min(H - 1, Math.max(0, y + dy)), xx = Math.min(W - 1, Math.max(0, px + dx)); window.push(from.data[(yy * W + xx) * 4 + ch]); }
        window.sort((a, b) => a - b);
        to.data[(y * W + px) * 4 + ch] = window[window.length >> 1];
      }
      x.putImageData(to, 0, 0);
      const scale = Math.max(1, Math.round(288 / Math.max(W, H)));
      const big = document.createElement('canvas'); big.width = W * scale; big.height = H * scale;
      const bx = big.getContext('2d'); bx.imageSmoothingEnabled = true; bx.imageSmoothingQuality = 'high'; bx.drawImage(c, 0, 0, big.width, big.height);
      return big.toDataURL('image/png').split(',')[1];
    })()`).catch(() => null) as string | null;
    return cleaned ? { mimeType: 'image/png', data: cleaned } : given;
  } finally { await blank.close().catch(quiet('agent/computer/human-check-geetest')); }
}

/** GeeTest's "select N images with <example>": a 3x3 drawing and a small example picture. The example is taken at
 * its full size and shown to the voting models beside the grid; the squares two of them name are clicked. */
async function solveGeetestMatch(page: Page, likeExample: Asks['likeExample'], random: () => number, sleep: (ms: number) => Promise<void>, trace?: (line: string) => void): Promise<boolean> {
  const info = await page.evaluate(`(() => {
    const ex = document.querySelector('[class*="geetest_ques_tips"] img');
    const grid = Array.from(document.querySelectorAll('[class*="geetest_svg_item"], [class*="geetest_subitem"][class*="geetest_svg"], [class*="geetest_subitem"][class*="geetest_nine"]')).find(e => { const r = e.getBoundingClientRect(); return r.width > 150 && r.height > 150; });
    const tips = document.querySelector('[class*="geetest_text_tips"]');
    if (!ex || !grid) return null;
    const r = grid.getBoundingClientRect();
    return { src: ex.src, grid: { x: r.x, y: r.y, width: r.width, height: r.height }, text: tips ? tips.textContent.trim() : '' };
  })()`).catch(() => null) as { src: string; grid: Box; text: string } | null;
  if (!info) return false;
  let example: Buffer | undefined;
  try {
    if (info.src.startsWith('data:')) example = Buffer.from(info.src.slice(info.src.indexOf(',') + 1), 'base64');
    else { const res = await fetchAsTab(page, info.src, { timeoutMs: 10_000 }); if (res.ok) example = res.body; }
  } catch { example = undefined; }
  if (!example) return false;
  const mime = /\.png(?:$|\?)/i.test(info.src) || example[0] === 0x89 ? 'image/png' : 'image/jpeg';
  const want = Math.max(1, Number(/(\d+)/.exec(info.text)?.[1] ?? 1));
  const w = info.grid.width / 3, h = info.grid.height / 3;
  const cells = Array.from({ length: 9 }, (_, i) => ({ x: info.grid.x + (i % 3) * w, y: info.grid.y + Math.floor(i / 3) * h, width: w, height: h }));
  let grid: Buffer;
  try { grid = await page.screenshot({ type: 'png', clip: info.grid, timeout: 8_000 }); } catch { return false; }
  const picked = await likeExample(await cleanPicture(page, example, mime), { mimeType: 'image/png', data: grid.toString('base64') }, want);
  if (picked?.length !== want) { trace?.(`GeeTest match ("${info.text}"): the voters did not agree on ${want}, asking for another`); return refreshGeetest(page, random, sleep); }
  trace?.(`GeeTest match ("${info.text}"): clicking square ${picked.join(', ')}`);
  for (const square of picked) await visitorClick(page.mouse, toTarget(cells[square - 1]!), random, sleep);
  await sleep(400);
  const submit = await page.evaluate(`(() => { const b = Array.from(document.querySelectorAll('[class*="geetest_submit"]')).find(e => { const r = e.getBoundingClientRect(); return r.width > 10 && r.height > 10 && r.bottom > 0 && r.top < innerHeight; }); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`).catch(() => null) as Box | null;
  if (submit) await visitorClick(page.mouse, toTarget(submit), random, sleep);
  return true;
}

/** Whether a GeeTest check is on the page and where it stands (runs in the page). */
export const GEETEST_STATE = `(() => {
  const shown = e => { const r = e.getBoundingClientRect(); return r.width > 8 && r.height > 8 && r.bottom > 0 && r.top < innerHeight && getComputedStyle(e).visibility !== 'hidden'; };
  const r = e => { const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; };
  const any = sel => Array.from(document.querySelectorAll(sel)).find(shown);
  if (any('[class*="geetest_lock_success"], [class*="geetest_success_radar"]')) return { state: 'done' };
  const box = Array.from(document.querySelectorAll('[class*="geetest_box"], [class*="geetest_panel_box"]')).find(e => shown(e) && e.getBoundingClientRect().height > 150);
  if (box) return { state: 'challenge' };
  const trigger = any('[class*="geetest_btn_click"], .geetest_radar_tip, .geetest_radar_btn');
  return trigger ? { state: 'button', trigger: r(trigger) } : null;
})()`;

/** One step on a GeeTest check: press its button if that is all that shows, else answer the challenge that is up.
 * Says whether it did anything. */
export async function geetestStep(hands: Hands): Promise<boolean> {
  const { page, random, sleep, trace, asks } = hands;
  let state = await page.evaluate(GEETEST_STATE).catch(() => null) as { state: 'done' | 'challenge' | 'button'; trigger?: Box } | null;
  if (!state || state.state === 'done') return false;
  if (state.state === 'button' && state.trigger) {
    trace?.('GeeTest: pressing its button');
    await visitorClick(page.mouse, toTarget(state.trigger), random, sleep);
    await sleep(3_000);
    state = await page.evaluate(GEETEST_STATE).catch(() => null) as typeof state;
    // The button alone can be enough: GeeTest passes a visitor it trusts without a challenge.
    if (!state || state.state !== 'challenge') return true;
  }
  if (await solveGeetestSlide(page, random, sleep, trace) || await solveGeetestBoard(page, random, sleep, trace)) return true;
  if (await solveGeetestIcons(page, asks.ordered, random, sleep, trace) || await solveGeetestMatch(page, asks.likeExample, random, sleep, trace)) return true;
  // A type this solver does not know: ask GeeTest for another.
  return refreshGeetest(page, random, sleep);
}
