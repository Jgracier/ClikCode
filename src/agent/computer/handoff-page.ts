/** The page the phone opens: the live view of the browser tab, and the phone's own controls for it. Plain HTML and JavaScript in one response
 * (no library, no second request, nothing from a third party). */
import { DIFF_SOURCE } from './handoff-input.js';

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
#accessory{display:none;gap:6px;align-items:center;padding:6px 8px;padding-bottom:max(6px,env(safe-area-inset-bottom));background:#161b22;border-top:1px solid #30363d}
#accessory.on{display:flex}
#label{font-size:11px;color:#8b949e;max-width:28%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#proxy{flex:1;min-width:0;font-size:16px;min-height:38px;box-sizing:border-box;background:#0d1117;color:#f0f6fc;border:1px solid #58a6ff;border-radius:8px;padding:0 10px;-webkit-user-select:text;user-select:text}
textarea#proxy{min-height:60px;padding:8px 10px}
#veil{position:absolute;inset:0;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.78);text-align:center;padding:24px;line-height:1.4}
#veil.on{display:flex}
</style>
<div id="app">
<div id="bar"><span id="dot"></span><span id="host">Connecting…</span><span id="ms"></span><button id="kb" aria-label="Keyboard">⌨</button><button id="done">Done</button></div>
<div id="stage"><canvas id="c" tabindex="0"></canvas><div id="veil" class="on"><span id="veilText">Connecting…</span></div></div>
<div id="accessory"><span id="label"></span><span id="slot" style="display:contents"></span><button id="tab">Tab</button><button id="enter">Go</button></div>
</div>
<script>
(() => {
const $ = (id) => document.getElementById(id);
const diffText = ${DIFF_SOURCE};
const base = location.pathname.replace(/\\/$/, '');
const canvas = $('c'), ctx = canvas.getContext('2d', { alpha: false });
const stage = $('stage'), app = $('app');
const T = window.__handoff = { frames: 0, latency: 0, focus: null, connected: false, ended: false };
let ws = null, retry = 0, finished = false, sentAt = 0, lastSize = '';

const veil = (text) => { $('veilText').textContent = text || ''; $('veil').classList.toggle('on', Boolean(text)); };
const send = (o) => { if (ws && ws.readyState === 1) { ws.send(JSON.stringify(o)); return true; } return false; };
const input = (o) => { if (!sentAt) sentAt = performance.now(); return send(o); };

// The app is as tall as what is visible: with the phone's keyboard up that is the area above it, and the page reflows to it.
const fit = () => { const v = window.visualViewport; if (v) { app.style.height = v.height + 'px'; app.style.top = v.offsetTop + 'px'; } };
if (window.visualViewport) { visualViewport.addEventListener('resize', fit); visualViewport.addEventListener('scroll', fit); }
fit();
let sizeTimer = 0;
const sendSize = (force) => {
  const w = stage.clientWidth, h = stage.clientHeight;
  if (w < 50 || h < 50) return;
  const o = { t: 'resize', w, h, dpr: Math.min(window.devicePixelRatio || 1, 3) };
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
    let m; try { m = JSON.parse(event.data); } catch (error) { return; }
    if (m.t === 'page') $('host').textContent = m.host || '';
    else if (m.t === 'focus') showFocus(m.d);
    else if (m.t === 'blur') hideFocus();
    else if (m.t === 'done') { finished = true; T.ended = true; veil('Done. ClikCode will continue.'); }
  };
};

// ── touch (a phone or tablet) ──
const slots = new Map();
const slotOf = (id) => { if (!slots.has(id)) { const used = new Set(slots.values()); let s = 0; while (used.has(s)) s++; slots.set(id, s); } return slots.get(id); };
const touches = (event) => {
  const r = canvas.getBoundingClientRect();
  return Array.from(event.touches).map((t) => [slotOf(t.identifier), Math.round((t.clientX - r.left) * 10) / 10, Math.round((t.clientY - r.top) * 10) / 10]);
};
const touch = (k) => (event) => {
  event.preventDefault();
  const p = touches(event);
  input({ t: 'touch', k, p });
  if (k === 'e' || k === 'c') { const live = new Set(Array.from(event.touches).map((t) => t.identifier)); for (const id of Array.from(slots.keys())) if (!live.has(id)) slots.delete(id); }
};
for (const [name, k] of [['touchstart', 's'], ['touchmove', 'm'], ['touchend', 'e'], ['touchcancel', 'c']]) canvas.addEventListener(name, touch(k), { passive: false });
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.body.addEventListener('touchmove', (e) => { if (!e.target.closest('#proxy')) e.preventDefault(); }, { passive: false });

// ── mouse and keyboard (a computer's browser) ──
let down = 0, lastMove = 0;
const at = (e) => { const r = canvas.getBoundingClientRect(); return { x: Math.round((e.clientX - r.left) * 10) / 10, y: Math.round((e.clientY - r.top) * 10) / 10 }; };
canvas.addEventListener('mousedown', (e) => { canvas.focus(); down = 1; input({ t: 'mouse', k: 'd', b: e.button, ...at(e) }); });
window.addEventListener('mouseup', (e) => { if (!down) return; down = 0; input({ t: 'mouse', k: 'u', b: e.button, ...at(e) }); });
canvas.addEventListener('mousemove', (e) => { const now = performance.now(); if (now - lastMove < 16) return; lastMove = now; send({ t: 'mouse', k: 'm', down, ...at(e) }); });
canvas.addEventListener('wheel', (e) => { e.preventDefault(); input({ t: 'mouse', k: 'w', dx: e.deltaX, dy: e.deltaY, ...at(e) }); }, { passive: false });
const NAMED = ['Enter', 'Tab', 'Backspace', 'Delete', 'Escape', 'ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'];
canvas.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (NAMED.includes(e.key)) { e.preventDefault(); input({ t: 'key', key: e.key }); }
  else if (e.key.length === 1) { e.preventDefault(); input({ t: 'text', s: e.key }); }
});

// ── the phone's own box for the field the page has focused ──
let proxy = null, proxyLast = '', multiline = false;
const hideFocus = () => { T.focus = null; $('accessory').classList.remove('on'); if (proxy) { proxy.remove(); proxy = null; } $('label').textContent = ''; };
const showFocus = (d) => {
  hideFocus(); T.focus = d;
  let el;
  if (d.kind === 'select') {
    el = document.createElement('select'); el.multiple = Boolean(d.multiple);
    for (const o of d.options) { const op = document.createElement('option'); op.value = o.v; op.textContent = o.t || o.v || '—'; op.selected = o.s; op.disabled = o.d; el.appendChild(op); }
    el.onchange = () => input({ t: 'set', v: d.multiple ? Array.from(el.selectedOptions).map((o) => o.value) : el.value });
  } else if (d.kind === 'native') {
    el = document.createElement('input'); el.type = d.type; if (d.min) el.min = d.min; if (d.max) el.max = d.max; if (d.step) el.step = d.step; el.value = d.value || '';
    el.oninput = () => input({ t: 'set', v: el.value });
  } else {
    multiline = Boolean(d.multiline);
    el = document.createElement(multiline ? 'textarea' : 'input');
    if (!multiline) el.type = d.type === 'editable' ? 'text' : d.type;
    if (d.inputmode) el.inputMode = d.inputmode;
    if (d.autocomplete) el.setAttribute('autocomplete', d.autocomplete);
    if (d.enterkeyhint) el.enterKeyHint = d.enterkeyhint;
    if (d.maxlength) el.maxLength = d.maxlength;
    if (['email', 'url', 'password'].includes(d.type)) { el.autocapitalize = 'off'; el.autocorrect = 'off'; el.spellcheck = false; }
    el.value = d.value || ''; proxyLast = el.value;
    el.addEventListener('input', () => {
      const { remove, add } = diffText(proxyLast, el.value);
      proxyLast = el.value;
      if (remove) input({ t: 'key', key: 'Backspace', n: remove });
      if (add) input({ t: 'text', s: add });
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !multiline) { e.preventDefault(); input({ t: 'key', key: 'Enter' }); }
      else if (e.key === 'Tab') { e.preventDefault(); input({ t: 'key', key: 'Tab' }); }
    });
  }
  el.id = 'proxy'; $('slot').appendChild(el); proxy = el;
  $('label').textContent = d.label || ''; $('accessory').classList.add('on');
  // Where the browser allows it the phone's keyboard comes up at once; on an iPhone the person's own tap on the box does it.
  try { el.focus({ preventScroll: true }); } catch (error) { /* tap the box */ }
};
for (const id of ['tab', 'enter', 'kb', 'done']) $(id).addEventListener('pointerdown', (e) => e.preventDefault());
$('tab').onclick = () => input({ t: 'key', key: 'Tab' });
$('enter').onclick = () => input({ t: 'key', key: 'Enter' });
$('kb').onclick = () => { if (T.focus) hideFocus(); else showFocus({ kind: 'text', type: 'text', value: '', label: 'Type into the page', multiline: false }); };
$('done').onclick = () => { send({ t: 'done' }); veil('Finishing…'); };

connect();
})();
</script></html>`;
}
