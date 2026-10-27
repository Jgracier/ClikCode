/** The page the phone opens: the browser tab as a form of real, fillable fields (the phone's own keyboard, autofill and pickers) or as a live
 * picture, and the phone's own controls for it. Plain HTML and JavaScript in one response (no library, no second request, nothing from a third party). */
export function handoffPage(): string {
  return `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
<meta name="referrer" content="no-referrer"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="theme-color" content="#161b22">
<title>Finish in ClikCode</title>
<style>
html,body{margin:0;height:100%;background:#0d1117;color:#f2f5f8;font:15px system-ui,-apple-system,sans-serif;overflow:hidden;overscroll-behavior:none;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none;-webkit-tap-highlight-color:transparent}
#app{position:fixed;left:0;right:0;top:0;height:100%;display:flex;flex-direction:column}
#bar{display:flex;align-items:center;gap:8px;padding:6px 10px;padding-top:max(6px,env(safe-area-inset-top));background:#161b22;border-bottom:1px solid #30363d;min-height:36px}
#dot{width:9px;height:9px;border-radius:50%;background:#d29922;flex:none}#dot.on{background:#3fb950}
#host{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;color:#c9d1d9}
#ms{font-size:12px;color:#8b949e;font-variant-numeric:tabular-nums}
button{font:inherit;min-height:34px;border-radius:8px;border:1px solid #484f58;background:#21262d;color:#f0f6fc;padding:0 12px}
#done{background:#238636;border-color:#2ea043;font-weight:600}
#stage{flex:1;min-height:0;position:relative;background:#000;overflow:hidden}
#c{position:absolute;left:0;top:0;touch-action:none;outline:none;background:#000}
#form{display:none;flex:1;min-height:0;overflow:auto;-webkit-overflow-scrolling:touch;background:#0d1117;padding:14px 14px calc(env(safe-area-inset-bottom) + 28px)}
.row{margin:0 0 16px}
.lab{font-size:13px;color:#8b949e;margin:0 0 6px}.lab.req::after{content:" *";color:#f85149}
.ctl{display:block;width:100%;box-sizing:border-box;font:inherit;font-size:16px;min-height:48px;padding:10px 12px;background:#161b22;color:#f0f6fc;border:1px solid #484f58;border-radius:10px;-webkit-user-select:text;user-select:text;-webkit-appearance:none;appearance:none}
.ctl:disabled,.act:disabled{opacity:.5}
.lab.locked::after{content:" · locked on this page";color:#6e7681}
.ctl:focus{outline:0;border-color:#58a6ff;box-shadow:0 0 0 3px rgba(88,166,255,.25)}
textarea.ctl{min-height:96px}
.chk{display:flex;gap:12px;align-items:center;min-height:46px;font-size:16px}.chk input{width:26px;height:26px;flex:none}
.act{display:block;width:100%;min-height:50px;font-size:17px;font-weight:600;background:#1f6feb;border-color:#388bfd}
.note{background:#1f3350;border:1px solid #1f6feb;border-radius:10px;padding:12px 14px;margin:0 0 16px;line-height:1.4}.note button{margin-top:10px;width:100%}
@media (max-width:430px){#ms{display:none}}
#veil{position:absolute;inset:0;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.78);text-align:center;padding:24px;line-height:1.4}
#veil.on{display:flex}
#sheet{display:none;position:absolute;inset:0;z-index:10;background:rgba(0,0,0,.55);align-items:flex-end}
#sheet.on{display:flex}
#sheetBox{width:100%;max-height:70%;display:flex;flex-direction:column;background:#161b22;border-radius:14px 14px 0 0;border-top:1px solid #30363d;padding-bottom:max(10px,env(safe-area-inset-bottom))}
#sheetTitle{padding:14px 16px 8px;font-weight:600;color:#c9d1d9}
#sheetBody{overflow:auto;-webkit-overflow-scrolling:touch;padding:0 10px}
#sheetActions{display:flex;gap:8px;padding:10px 10px 0}#sheetActions button{flex:1}
.opt{display:block;width:100%;text-align:left;min-height:46px;margin:0 0 6px;font-size:16px}
.opt.on{border-color:#58a6ff;background:#1f3350}
#sheetInput{width:100%;box-sizing:border-box;font-size:18px;min-height:46px;background:#0d1117;color:#f0f6fc;border:1px solid #58a6ff;border-radius:8px;padding:0 10px;margin-bottom:6px}
</style>
<div id="app">
<div id="bar"><span id="dot"></span><span id="host">Connecting…</span><span id="ms"></span><button id="view" aria-label="Switch between the fields and the page">Fields</button><button id="mode" aria-label="Switch between touch and mouse">Mouse</button><button id="done">Done</button></div>
<div id="stage"><canvas id="c" tabindex="0"></canvas><div id="veil" class="on"><span id="veilText">Connecting…</span></div></div>
<div id="form"><div id="formBody"></div></div>
<div id="sheet"><div id="sheetBox"><div id="sheetTitle"></div><div id="sheetBody"></div><div id="sheetActions"></div></div></div>
</div>
<script>
(() => {
const $ = (id) => document.getElementById(id);
const base = location.pathname.replace(/\\/$/, '');
const canvas = $('c'), ctx = canvas.getContext('2d', { alpha: false });
const stage = $('stage'), app = $('app');
const T = window.__handoff = { frames: 0, latency: 0, connected: false, ended: false, mode: 'touch', view: 'auto', fields: 0 };
let ws = null, retry = 0, finished = false, sentAt = 0, lastSize = '';

// Touch on a phone or tablet, mouse on a computer; the button beside Done switches, and says what it would switch to.
let mode = '';
try { mode = localStorage.getItem('clikcode-handoff-mode') || ''; } catch (error) { /* private browsing */ }
if (mode !== 'touch' && mode !== 'mouse') mode = matchMedia('(pointer: coarse)').matches ? 'touch' : 'mouse';
T.mode = mode;
const showMode = () => { $('mode').textContent = mode === 'touch' ? 'Mouse' : 'Touch'; };
showMode();

const veil = (text) => { $('veilText').textContent = text || ''; $('veil').classList.toggle('on', Boolean(text)); };
const send = (o) => { if (ws && ws.readyState === 1) { ws.send(JSON.stringify(o)); return true; } return false; };
const input = (o) => { if (!sentAt) sentAt = performance.now(); return send(o); };
const round1 = (n) => Math.round(n * 10) / 10;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// The app is as tall as what is visible: with the phone's keyboard up that is the area above it, and the page reflows to it.
const fit = () => { const v = window.visualViewport; if (v) { app.style.height = v.height + 'px'; app.style.top = v.offsetTop + 'px'; } };
if (window.visualViewport) { visualViewport.addEventListener('resize', fit); visualViewport.addEventListener('scroll', fit); }
fit();
let sizeTimer = 0;
const sendSize = (force) => {
  const area = stage.clientWidth >= 50 ? stage : $('form');
  const w = area.clientWidth, h = area.clientHeight;
  if (w < 50 || h < 50) return;
  const o = { t: 'resize', w, h, dpr: Math.min(window.devicePixelRatio || 1, 3), m: mode };
  const key = JSON.stringify(o);
  if (!force && key === lastSize) return;
  lastSize = key;
  canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
  send(o);
};
const resizer = new ResizeObserver(() => { clearTimeout(sizeTimer); sizeTimer = setTimeout(() => sendSize(false), 80); });
resizer.observe(stage); resizer.observe($('form'));

// ── frames ──
let decoding = false, newest = null;
const drawNewest = async () => {
  decoding = true;
  while (newest) {
    const bytes = newest; newest = null;
    try {
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
      if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) { canvas.width = bitmap.width; canvas.height = bitmap.height; }
      ctx.drawImage(bitmap, 0, 0);
      if (bitmap.close) bitmap.close();
      T.frames++;
      if (T.frames === 1) veil('');
      if (sentAt) { T.latency = Math.round(performance.now() - sentAt); sentAt = 0; $('ms').textContent = T.latency + ' ms'; }
    } catch (error) { /* a frame that cannot be drawn is skipped */ }
    send({ t: 'ack' });
  }
  decoding = false;
};

// ── connection ──
let fields = [], captcha = false;
const connect = () => {
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + base + '/live');
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => { retry = 0; T.connected = true; $('dot').className = 'on'; lastSize = ''; sendSize(true); send({ t: 'view', v: view === 'fields' ? 'fields' : 'page' }); };
  ws.onclose = async () => {
    T.connected = false; $('dot').className = '';
    if (finished) return;
    retry++;
    let alive = true;
    try { alive = (await fetch(base + '/ping', { cache: 'no-store' })).status !== 410; } catch (error) { alive = true; }
    if (!alive) { finished = true; T.ended = true; veil('This link has ended. Ask ClikCode for a new one if you still need it.'); return; }
    veil('Reconnecting…');
    setTimeout(connect, Math.min(1000, 150 * retry));
  };
  ws.onmessage = (event) => {
    if (typeof event.data !== 'string') { newest = new Uint8Array(event.data, 1); if (!decoding) drawNewest(); return; }
    let msg; try { msg = JSON.parse(event.data); } catch (error) { return; }
    if (msg.t === 'page') $('host').textContent = msg.host || '';
    else if (msg.t === 'fields') { fields = Array.isArray(msg.f) ? msg.f : []; captcha = Boolean(msg.c); T.fields = fields.length; gotFields(); }
    else if (msg.t === 'done') { finished = true; T.ended = true; veil('Done. ClikCode will continue.'); }
  };
};

// ── where the page's fields are on this screen ──
const fieldAt = (x, y) => {
  let best = null;
  for (const f of fields) {
    if (f.d.disabled || (f.d.kind !== 'text' && f.d.kind !== 'select' && f.d.kind !== 'native')) continue;
    if (x < f.x - 6 || x > f.x + f.w + 6 || y < f.y - 6 || y > f.y + f.h + 6) continue;
    if (!best || f.w * f.h < best.w * best.h) best = f;
  }
  return best;
};
const needsSheet = (f) => Boolean(f) && (f.d.kind === 'select' || f.d.kind === 'native');

// ── touch or mouse, on a phone's screen ──
const slots = new Map();
const slotOf = (id) => { if (!slots.has(id)) { const used = new Set(slots.values()); let s = 0; while (used.has(s)) s++; slots.set(id, s); } return slots.get(id); };
let g = null;       // touch mode: the one finger that is down
let m = null;       // mouse mode: the one finger that is the pointer
let two = null;     // mouse mode: two fingers (scroll, or a right click)
const mid = (list) => ({ x: round1(list.reduce((n, p) => n + p.x, 0) / list.length), y: round1(list.reduce((n, p) => n + p.y, 0) / list.length) });

const touchMode = (k, list) => {
  const pts = list.map((p) => [p.id, p.x, p.y]);
  if (k === 's') {
    if (list.length === 1) {
      const f = fieldAt(list[0].x, list[0].y);
      g = { x: list[0].x, y: list[0].y, t: performance.now(), moved: false, field: f, held: needsSheet(f) };
      // A choice or a date is the phone's own sheet: the tap is kept from the page (its pop-up would open on the computer, unseen) unless it turns into a drag.
      if (g.held) return;
    } else if (g) {
      if (g.held) { g.held = false; input({ t: 'touch', k: 's', p: [[0, g.x, g.y]] }); }
      g.moved = true;
    }
    input({ t: 'touch', k: 's', p: pts });
    return;
  }
  if (k === 'm') {
    if (g && !g.moved && list.length === 1 && dist(list[0], g) > 10) {
      g.moved = true;
      if (g.held) { g.held = false; input({ t: 'touch', k: 's', p: [[list[0].id, g.x, g.y]] }); }
    }
    if (g && g.held) return;
    input({ t: 'touch', k: 'm', p: pts });
    return;
  }
  if (g && g.held) {
    const tap = k === 'e' && !g.moved && performance.now() - g.t < 700;
    const f = g.field; g = null;
    if (tap) openSheet(f.d, f.i);
    return;
  }
  input({ t: 'touch', k, p: pts });
  if (list.length === 0 && g) {
    const tap = k === 'e' && !g.moved && performance.now() - g.t < 700;
    const f = tap ? fieldAt(g.x, g.y) : null;
    g = null;
    // In the person's own tap, so the phone lets its keyboard come up.
    if (f && f.d.kind === 'text') gotoField(f);
  }
};

const mouseMode = (k, list) => {
  const now = performance.now();
  const press = () => { if (!m || m.pressed || m.held) return; m.pressed = true; input({ t: 'mouse', k: 'd', b: 0, x: m.x, y: m.y }); };
  if (k === 's') {
    if (list.length === 1) {
      const p = list[0], f = fieldAt(p.x, p.y);
      m = { x: p.x, y: p.y, t: now, pressed: false, moved: false, held: needsSheet(f), field: f, timer: 0, last: p };
      send({ t: 'mouse', k: 'm', x: p.x, y: p.y, down: 0 });
      // A moment's wait, so a second finger landing (a scroll, a right click) is not first taken for a click.
      if (!m.held) m.timer = setTimeout(press, 50);
    } else {
      if (m) { clearTimeout(m.timer); if (m.pressed) input({ t: 'mouse', k: 'u', b: 0, x: m.last.x, y: m.last.y }); m = null; }
      two = { mid: mid(list), t: now, moved: 0 };
    }
    return;
  }
  if (k === 'm') {
    if (list.length >= 2 && two) {
      const c = mid(list), dx = two.mid.x - c.x, dy = two.mid.y - c.y;
      two.moved += Math.abs(dx) + Math.abs(dy); two.mid = c;
      if (dx || dy) input({ t: 'mouse', k: 'w', dx, dy, x: c.x, y: c.y });
    } else if (list.length === 1 && m) {
      const p = list[0];
      if (!m.moved && dist(p, m) > 8) { m.moved = true; clearTimeout(m.timer); m.held = false; press(); }
      if (m.moved) { m.last = p; input({ t: 'mouse', k: 'm', x: p.x, y: p.y, down: 1 }); }
    }
    return;
  }
  if (two) {
    if (list.length === 0) {
      if (k === 'e' && now - two.t < 350 && two.moved < 12) { input({ t: 'mouse', k: 'd', b: 2, x: two.mid.x, y: two.mid.y }); input({ t: 'mouse', k: 'u', b: 2, x: two.mid.x, y: two.mid.y }); }
      two = null;
    }
    return;
  }
  if (m && list.length === 0) {
    clearTimeout(m.timer);
    const tap = k === 'e' && !m.moved && now - m.t < 700, f = m.field;
    if (m.held) { m = null; if (tap) openSheet(f.d, f.i); return; }
    if (!m.pressed) press();
    input({ t: 'mouse', k: 'u', b: 0, x: m.last.x, y: m.last.y });
    m = null;
    if (tap && f && f.d.kind === 'text') gotoField(f);
  }
};

const onTouch = (k) => (event) => {
  event.preventDefault();
  const r = canvas.getBoundingClientRect();
  const list = Array.from(event.touches).map((t) => ({ id: slotOf(t.identifier), x: round1(t.clientX - r.left), y: round1(t.clientY - r.top) }));
  if (mode === 'touch') touchMode(k, list); else mouseMode(k, list);
  if (k === 'e' || k === 'c') { const live = new Set(Array.from(event.touches).map((t) => t.identifier)); for (const id of Array.from(slots.keys())) if (!live.has(id)) slots.delete(id); }
};
for (const [name, k] of [['touchstart', 's'], ['touchmove', 'm'], ['touchend', 'e'], ['touchcancel', 'c']]) canvas.addEventListener(name, onTouch(k), { passive: false });
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.body.addEventListener('touchmove', (e) => { if (!e.target.closest('#form, #sheetBody')) e.preventDefault(); }, { passive: false });

// A computer's own mouse and keyboard.
let down = null, lastMove = 0;
const at = (e) => { const r = canvas.getBoundingClientRect(); return { x: round1(e.clientX - r.left), y: round1(e.clientY - r.top) }; };
canvas.addEventListener('mousedown', (e) => {
  canvas.focus();
  const p = at(e), f = fieldAt(p.x, p.y);
  down = { x: p.x, y: p.y, field: f, held: needsSheet(f) && e.button === 0 };
  if (!down.held) input({ t: 'mouse', k: 'd', b: e.button, ...p });
});
window.addEventListener('mouseup', (e) => {
  if (!down) return;
  const p = at(e), d = down; down = null;
  if (d.held) { if (dist(p, d) < 6) openSheet(d.field.d, d.field.i); return; }
  input({ t: 'mouse', k: 'u', b: e.button, ...p });
  if (d.field && d.field.d.kind === 'text' && dist(p, d) < 6) gotoField(d.field);
});
canvas.addEventListener('mousemove', (e) => { const now = performance.now(); if (now - lastMove < 16 || (down && down.held)) return; lastMove = now; send({ t: 'mouse', k: 'm', down: down ? 1 : 0, ...at(e) }); });
canvas.addEventListener('wheel', (e) => { e.preventDefault(); input({ t: 'mouse', k: 'w', dx: e.deltaX, dy: e.deltaY, ...at(e) }); }, { passive: false });
const NAMED = ['Enter', 'Tab', 'Backspace', 'Delete', 'Escape', 'ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'];
canvas.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (NAMED.includes(e.key)) { e.preventDefault(); input({ t: 'key', key: e.key }); }
  else if (e.key.length === 1) { e.preventDefault(); input({ t: 'text', s: e.key }); }
});

// ── the fields: a real form ──
// Every fillable control on the page, as the phone's own: tap one and the phone's keyboard (or picker) comes up, autofill and the password
// manager work, and what is entered goes into the real field on the page as it is typed.
const el = (tag, className, text) => { const n = document.createElement(tag); if (className) n.className = className; if (text !== undefined) n.textContent = text; return n; };
const note = (text, action, go) => { const n = el('div', 'note', text); const b = el('button', '', action); b.onclick = go; n.appendChild(b); return n; };
const buildRow = (f) => {
  const d = f.d, row = el('div', 'row');
  if (d.kind === 'button') { const b = el('button', 'act', d.label); b.disabled = Boolean(d.disabled); b.onclick = () => input({ t: 'press', i: f.i }); row.appendChild(b); return row; }
  if (d.kind === 'check') {
    const l = el('label', 'chk'), c = el('input'); c.type = d.type; c.checked = Boolean(d.checked); c.disabled = Boolean(d.disabled); c.dataset.i = String(f.i);
    c.onchange = () => input({ t: 'check', i: f.i, v: c.checked });
    l.appendChild(c); l.appendChild(el('span', '', d.label || (d.type === 'radio' ? 'Option' : 'Tick this')));
    row.appendChild(l); return row;
  }
  row.appendChild(el('div', 'lab' + (d.required ? ' req' : '') + (d.disabled ? ' locked' : ''), d.label || d.placeholder || 'Field'));
  let c;
  if (d.kind === 'select') {
    c = el('select'); c.multiple = Boolean(d.multiple);
    for (const o of d.options) { const op = el('option', '', o.t || o.v || '—'); op.value = o.v; op.selected = Boolean(o.s); op.disabled = Boolean(o.d); c.appendChild(op); }
    c.onchange = () => input({ t: 'set', i: f.i, v: d.multiple ? Array.from(c.selectedOptions).map((o) => o.value) : c.value });
  } else if (d.kind === 'native') {
    c = el('input'); c.type = d.type; if (d.min) c.min = d.min; if (d.max) c.max = d.max; if (d.step) c.step = d.step; c.value = d.value || '';
    c.onchange = () => input({ t: 'set', i: f.i, v: c.value });
  } else {
    const multiline = Boolean(d.multiline);
    c = el(multiline ? 'textarea' : 'input');
    if (!multiline) c.type = d.type === 'editable' ? 'text' : d.type;
    if (d.inputmode) c.inputMode = d.inputmode;
    if (d.autocomplete) c.setAttribute('autocomplete', d.autocomplete);
    if (d.enterkeyhint) c.enterKeyHint = d.enterkeyhint;
    if (d.maxlength) c.maxLength = d.maxlength;
    if (d.placeholder) c.placeholder = d.placeholder;
    if (['email', 'url', 'password'].includes(d.type)) { c.autocapitalize = 'off'; c.autocorrect = 'off'; c.spellcheck = false; }
    c.value = d.value || '';
    c.addEventListener('input', () => input({ t: 'fill', i: f.i, v: c.value }));
    if (!multiline) c.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); input({ t: 'key', key: 'Enter' }); } });
  }
  c.className = 'ctl'; c.dataset.i = String(f.i); c.disabled = Boolean(d.disabled);
  row.appendChild(c); return row;
};
let formKey = '';
// The page changed: put its new values in the controls that are not being typed in (a password's value is never sent, so it is left alone).
const patchForm = () => {
  const body = $('formBody');
  for (const f of fields) {
    const c = body.querySelector('[data-i="' + f.i + '"]'), d = f.d;
    if (!c) continue;
    c.disabled = Boolean(d.disabled);
    if (c === document.activeElement || d.type === 'password') continue;
    if (d.kind === 'check') c.checked = Boolean(d.checked);
    else if (d.kind === 'select') { for (const o of c.options) o.selected = d.options.some((x) => x.v === o.value && x.s); }
    else if ((d.kind === 'text' || d.kind === 'native') && c.value !== (d.value || '')) c.value = d.value || '';
  }
};
const renderForm = () => {
  const body = $('formBody');
  const key = JSON.stringify([captcha, fields.map((f) => [f.i, f.d.kind, f.d.type || '', f.d.label || '', f.d.options ? f.d.options.length : 0, Boolean(f.d.disabled)])]);
  if (key === formKey) { patchForm(); return; }
  formKey = key;
  // A field being typed in is kept as it is, caret and all, when the form is rebuilt around it.
  const active = document.activeElement && body.contains(document.activeElement) ? document.activeElement : null;
  const keep = active ? { i: active.dataset.i, value: active.value, start: active.selectionStart, end: active.selectionEnd } : null;
  body.textContent = '';
  if (captcha) body.appendChild(note('This page also has a picture check (CAPTCHA). It cannot be filled in as a field: open the page to do it.', 'Open the page', () => setView('page', true)));
  if (!fields.length) body.appendChild(note('There is nothing to fill in on this page.', 'Open the page', () => setView('page', true)));
  for (const f of fields) body.appendChild(buildRow(f));
  if (keep) { const c = body.querySelector('[data-i="' + keep.i + '"]'); if (c) { c.value = keep.value; try { c.focus({ preventScroll: true }); c.setSelectionRange(keep.start, keep.end); } catch (error) { /* a field that has no caret */ } } }
};

// ── the fields or the page ──
let view = '';
try { view = localStorage.getItem('clikcode-handoff-view') || ''; } catch (error) { /* private browsing */ }
if (view !== 'fields' && view !== 'page') view = 'auto';
const applyView = () => {
  const form = view === 'fields';
  $('form').style.display = form ? 'block' : 'none';
  $('stage').style.display = form ? 'none' : '';
  $('view').textContent = form ? 'Page' : 'Fields';
  T.view = view;
  send({ t: 'view', v: form ? 'fields' : 'page' });
  if (form) renderForm(); else { lastSize = ''; setTimeout(() => sendSize(true), 40); }
};
const setView = (v, remember) => {
  view = v;
  if (remember) { try { localStorage.setItem('clikcode-handoff-view', v); } catch (error) { /* private browsing */ } }
  applyView();
};
// The first time the page's fields are known: a page with something to fill in opens as the form, one without as the picture.
const gotFields = () => {
  if (view === 'auto') setView(fields.some((f) => f.d.kind !== 'button' && !f.d.disabled) ? 'fields' : 'page', false);
  else if (view === 'fields') renderForm();
};
// A tap on a text field in the picture goes to that field in the form, in the tap itself, so the phone brings up its keyboard.
const gotoField = (f) => {
  view = 'fields'; T.view = view; applyView();
  const c = $('formBody').querySelector('[data-i="' + f.i + '"]');
  if (c) { try { c.focus(); } catch (error) { /* nothing to do */ } if (c.scrollIntoView) c.scrollIntoView({ block: 'center' }); }
};
applyView();

// ── a choice or a date: the phone's own sheet ──
const closeSheet = () => { $('sheet').classList.remove('on'); $('sheetBody').textContent = ''; $('sheetActions').textContent = ''; };
const openSheet = (d, idx) => {
  closeSheet();
  $('sheetTitle').textContent = d.label || (d.kind === 'select' ? 'Choose' : 'Set');
  const body = $('sheetBody'), actions = $('sheetActions');
  const action = (text, handler) => { const b = document.createElement('button'); b.textContent = text; b.onclick = handler; actions.appendChild(b); return b; };
  if (d.kind === 'select') {
    const chosen = new Set(d.options.filter((o) => o.s).map((o) => o.v));
    for (const o of d.options) {
      const b = document.createElement('button');
      b.className = 'opt' + (chosen.has(o.v) ? ' on' : ''); b.textContent = o.t || o.v || '—'; b.disabled = Boolean(o.d);
      b.onclick = () => {
        if (!d.multiple) { input({ t: 'set', i: idx, v: o.v }); closeSheet(); return; }
        if (chosen.has(o.v)) chosen.delete(o.v); else chosen.add(o.v);
        b.classList.toggle('on');
      };
      body.appendChild(b);
    }
    if (d.multiple) action('OK', () => { input({ t: 'set', i: idx, v: Array.from(chosen) }); closeSheet(); });
  } else {
    const el = document.createElement('input');
    el.id = 'sheetInput'; el.type = d.type; if (d.min) el.min = d.min; if (d.max) el.max = d.max; if (d.step) el.step = d.step; el.value = d.value || '';
    body.appendChild(el);
    action('OK', () => { input({ t: 'set', i: idx, v: el.value }); closeSheet(); });
  }
  action('Cancel', closeSheet);
  $('sheet').classList.add('on');
};
$('sheet').addEventListener('click', (e) => { if (e.target === $('sheet')) closeSheet(); });

// ── the bar ──
for (const id of ['view', 'mode', 'done']) $(id).addEventListener('pointerdown', (e) => e.preventDefault());
$('view').onclick = () => setView(view === 'fields' ? 'page' : 'fields', true);
$('mode').onclick = () => {
  mode = mode === 'touch' ? 'mouse' : 'touch'; T.mode = mode;
  try { localStorage.setItem('clikcode-handoff-mode', mode); } catch (error) { /* private browsing */ }
  showMode();
  if (m) clearTimeout(m.timer);
  g = null; m = null; two = null; down = null;
  lastSize = ''; sendSize(true);
};
$('done').onclick = () => { send({ t: 'done' }); veil('Finishing…'); };

connect();
})();
</script></html>`;
}
