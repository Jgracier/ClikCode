/** The page the phone opens: the live view of the browser tab, with the phone's own controls laid over the page's fields, and the phone's own
 * buttons for it. Plain HTML and JavaScript in one response (no library, no second request, nothing from a third party). */

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
#overlays{position:absolute;inset:0;z-index:4;pointer-events:none}
#overlays>*{position:absolute;box-sizing:border-box;margin:0;padding:0;border:0;border-radius:0;outline:0;background:transparent;color:transparent;caret-color:transparent;opacity:.01;font-size:16px;pointer-events:auto;touch-action:none;resize:none;-webkit-appearance:none;appearance:none;-webkit-user-select:text;user-select:text}
#overlays.moving>*{pointer-events:none}
#veil{position:absolute;inset:0;z-index:6;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.78);text-align:center;padding:24px;line-height:1.4}
#veil.on{display:flex}
@media (max-width:430px){#ms{display:none}}
</style>
<div id="app">
<div id="bar"><span id="dot"></span><span id="host">Connecting…</span><span id="ms"></span><button id="mode" aria-label="Switch between touch and mouse">Mouse</button><button id="done">Done</button></div>
<div id="stage"><canvas id="c" tabindex="0"></canvas><div id="overlays"></div><div id="veil" class="on"><span id="veilText">Connecting…</span></div></div>
</div>
<script>
(() => {
const $ = (id) => document.getElementById(id);
const base = location.pathname.replace(/\\/$/, '');
const canvas = $('c'), ctx = canvas.getContext('2d', { alpha: false });
const stage = $('stage'), app = $('app'), overlays = $('overlays');
const T = window.__handoff = { frames: 0, latency: 0, connected: false, ended: false, mode: 'touch', fields: 0, overlays: 0 };
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
const el = (tag, className, text) => { const n = document.createElement(tag); if (className) n.className = className; if (text !== undefined) n.textContent = text; return n; };

// The app is as tall as what is visible: with the phone's keyboard up that is the area above it, and the page reflows to it.
const fit = () => { const v = window.visualViewport; if (v) { app.style.height = v.height + 'px'; app.style.top = v.offsetTop + 'px'; } };
if (window.visualViewport) { visualViewport.addEventListener('resize', fit); visualViewport.addEventListener('scroll', fit); }
fit();
let sizeTimer = 0;
const sendSize = (force) => {
  const w = stage.clientWidth, h = stage.clientHeight;
  if (w < 50 || h < 50) return;
  const o = { t: 'resize', w, h, dpr: Math.min(window.devicePixelRatio || 1, 3), m: mode };
  const key = JSON.stringify(o);
  if (!force && key === lastSize) return;
  lastSize = key;
  canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
  send(o);
};
new ResizeObserver(() => { clearTimeout(sizeTimer); sizeTimer = setTimeout(() => sendSize(false), 80); }).observe(stage);

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
let fields = [];
const connect = () => {
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + base + '/live');
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => { retry = 0; T.connected = true; $('dot').className = 'on'; lastSize = ''; sendSize(true); };
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
    else if (msg.t === 'fields') { fields = Array.isArray(msg.f) ? msg.f : []; T.fields = fields.length; syncOverlays(); }
    else if (msg.t === 'done') { finished = true; T.ended = true; veil('Done. ClikCode will continue.'); }
  };
};

// ── the page's fields, as the phone's own inputs, in place ──
// A real input is laid over each field in the picture, so a finger that touches a field lands on an input of the phone itself: the phone
// opens its own keyboard (with the field's kind, autofill and Enter key) or its own picker, with nothing for the page to ask it to do. What is
// entered is put into the page's field; the picture shows it arrive.
const overlay = new Map();
const isOverlay = (n) => Boolean(n && n.closest && n.closest('#overlays > *'));
const place = (e, f) => { e.style.left = f.x + 'px'; e.style.top = f.y + 'px'; e.style.width = Math.max(f.w, 24) + 'px'; e.style.height = Math.max(f.h, 24) + 'px'; };
const signature = (f) => JSON.stringify([f.d.kind, f.d.type || '', f.d.options ? f.d.options.length : 0, f.d.multiline ? 1 : 0, f.d.inputmode || '', f.d.autocomplete || '', f.d.enterkeyhint || '']);
const makeOverlay = (f) => {
  const d = f.d;
  let e;
  if (d.kind === 'select') {
    e = el('select'); e.multiple = Boolean(d.multiple);
    for (const o of d.options) { const op = el('option', '', o.t || o.v || '—'); op.value = o.v; op.selected = Boolean(o.s); op.disabled = Boolean(o.d); e.appendChild(op); }
    e.onchange = () => input({ t: 'set', i: f.i, v: d.multiple ? Array.from(e.selectedOptions).map((o) => o.value) : e.value });
  } else if (d.kind === 'native') {
    e = el('input'); e.type = d.type; if (d.min) e.min = d.min; if (d.max) e.max = d.max; if (d.step) e.step = d.step; e.value = d.value || '';
    e.onchange = () => input({ t: 'set', i: f.i, v: e.value });
  } else {
    const multiline = Boolean(d.multiline);
    e = el(multiline ? 'textarea' : 'input');
    if (!multiline) e.type = d.type === 'editable' ? 'text' : d.type;
    if (d.inputmode) e.inputMode = d.inputmode;
    if (d.autocomplete) e.setAttribute('autocomplete', d.autocomplete);
    if (d.enterkeyhint) e.enterKeyHint = d.enterkeyhint;
    if (d.maxlength) e.maxLength = d.maxlength;
    if (['email', 'url', 'password'].includes(d.type)) { e.autocapitalize = 'off'; e.autocorrect = 'off'; e.spellcheck = false; }
    e.value = d.value || '';
    e.addEventListener('input', () => input({ t: 'fill', i: f.i, v: e.value }));
    if (!multiline) e.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); input({ t: 'key', key: 'Enter' }); } });
  }
  e.dataset.i = String(f.i); e.dataset.sig = signature(f);
  return e;
};
const syncOverlays = () => {
  const keep = new Set();
  for (const f of fields) {
    let e = overlay.get(f.i);
    // The one being typed in is never replaced or rewritten under the person's finger.
    if (e && e.dataset.sig !== signature(f) && e !== document.activeElement) { e.remove(); overlay.delete(f.i); e = undefined; }
    if (!e) { e = makeOverlay(f); overlays.appendChild(e); overlay.set(f.i, e); }
    place(e, f); keep.add(f.i);
    if (e === document.activeElement || f.d.type === 'password') continue;
    if (f.d.kind === 'select') { for (const o of e.options) o.selected = f.d.options.some((x) => x.v === o.value && x.s); }
    else if (e.value !== (f.d.value || '')) e.value = f.d.value || '';
  }
  for (const [i, e] of Array.from(overlay)) if (!keep.has(i) && e !== document.activeElement) { e.remove(); overlay.delete(i); }
  T.overlays = overlay.size;
};
const fieldAt = (x, y) => {
  let best = null;
  for (const f of fields) {
    if (x < f.x - 6 || x > f.x + f.w + 6 || y < f.y - 6 || y > f.y + f.h + 6) continue;
    if (!best || f.w * f.h < best.w * best.h) best = f;
  }
  return best;
};
// A choice or a date is the phone's own picker: the tap is kept from the page (its pop-up would open on the computer, unseen).
const holds = (f) => Boolean(f) && (f.d.kind === 'select' || f.d.kind === 'native');

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
      g = { x: list[0].x, y: list[0].y, t: performance.now(), moved: false, held: holds(f) };
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
  if (g && g.held) { g = null; return; }
  input({ t: 'touch', k, p: pts });
  if (list.length === 0) g = null;
};

const mouseMode = (k, list) => {
  const now = performance.now();
  const press = () => { if (!m || m.pressed || m.held) return; m.pressed = true; input({ t: 'mouse', k: 'd', b: 0, x: m.x, y: m.y }); };
  if (k === 's') {
    if (list.length === 1) {
      const p = list[0], f = fieldAt(p.x, p.y);
      m = { x: p.x, y: p.y, t: now, pressed: false, moved: false, held: holds(f), timer: 0, last: p };
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
    if (m.held) { m = null; return; }
    if (!m.pressed) press();
    input({ t: 'mouse', k: 'u', b: 0, x: m.last.x, y: m.last.y });
    m = null;
  }
};

// A plain tap on one of the phone's own inputs is left to the phone, which focuses it and opens its keyboard or picker. Anything else is ours:
// a drag that starts on a field is a scroll (the input is stepped aside for it), and a tap elsewhere puts the keyboard away.
let onField = false, dragged = false, startAt = null;
const onTouch = (k) => (event) => {
  const r = canvas.getBoundingClientRect();
  const list = Array.from(event.touches).map((t) => ({ id: slotOf(t.identifier), x: round1(t.clientX - r.left), y: round1(t.clientY - r.top) }));
  if (k === 's') { dragged = false; startAt = list[0] || null; onField = list.length === 1 && isOverlay(event.target); }
  if (k === 'm' && startAt && !dragged && (list.length > 1 || (list[0] && dist(list[0], startAt) > 10))) dragged = true;
  if (!(onField && !dragged)) event.preventDefault();
  if (mode === 'touch') touchMode(k, list); else mouseMode(k, list);
  if (k === 'e' || k === 'c') {
    const tapAway = k === 'e' && !dragged && !onField;
    if (tapAway && document.activeElement && isOverlay(document.activeElement)) document.activeElement.blur();
    const live = new Set(Array.from(event.touches).map((t) => t.identifier));
    for (const id of Array.from(slots.keys())) if (!live.has(id)) slots.delete(id);
    // After a drag the inputs wait a moment, until the page has told the phone where its fields have moved to (a tap on one at its old place would miss).
    if (list.length === 0) { onField = false; if (dragged) { overlays.classList.add('moving'); setTimeout(() => overlays.classList.remove('moving'), 300); } }
  }
};
for (const [name, k] of [['touchstart', 's'], ['touchmove', 'm'], ['touchend', 'e'], ['touchcancel', 'c']]) stage.addEventListener(name, onTouch(k), { passive: false });
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.body.addEventListener('touchmove', (e) => { if (!(onField && !dragged)) e.preventDefault(); }, { passive: false });

// A computer's own mouse and keyboard.
let down = null, lastMove = 0;
const at = (e) => { const r = canvas.getBoundingClientRect(); return { x: round1(e.clientX - r.left), y: round1(e.clientY - r.top) }; };
stage.addEventListener('mousedown', (e) => {
  if (isOverlay(e.target)) return;
  canvas.focus();
  const p = at(e), f = fieldAt(p.x, p.y);
  if (document.activeElement && isOverlay(document.activeElement)) document.activeElement.blur();
  down = { x: p.x, y: p.y, held: holds(f) && e.button === 0 };
  if (!down.held) input({ t: 'mouse', k: 'd', b: e.button, ...p });
});
window.addEventListener('mouseup', (e) => {
  if (!down) return;
  const p = at(e), d = down; down = null;
  if (!d.held) input({ t: 'mouse', k: 'u', b: e.button, ...p });
});
stage.addEventListener('mousemove', (e) => { const now = performance.now(); if (now - lastMove < 16 || (down && down.held)) return; lastMove = now; send({ t: 'mouse', k: 'm', down: down ? 1 : 0, ...at(e) }); });
stage.addEventListener('wheel', (e) => { e.preventDefault(); input({ t: 'mouse', k: 'w', dx: e.deltaX, dy: e.deltaY, ...at(e) }); }, { passive: false });
const NAMED = ['Enter', 'Tab', 'Backspace', 'Delete', 'Escape', 'ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'];
canvas.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (NAMED.includes(e.key)) { e.preventDefault(); input({ t: 'key', key: e.key }); }
  else if (e.key.length === 1) { e.preventDefault(); input({ t: 'text', s: e.key }); }
});

// ── the bar ──
for (const id of ['mode', 'done']) $(id).addEventListener('pointerdown', (e) => e.preventDefault());
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
