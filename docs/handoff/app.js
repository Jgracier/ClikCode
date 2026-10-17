// Tailcat browser transport. The address and session token are URL fragments;
// GitHub Pages never receives them. The local worker owns the browser.
const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.hash.slice(1));
const addr = params.get('addr');
const token = params.get('token');
const port = Number(params.get('port'));
history.replaceState(null, '', location.pathname);
const status = message => { $('status').textContent = message; };
let conn;
let imageUrl;
let sendChain = Promise.resolve();
function send(action) {
  sendChain = sendChain.then(async () => {
    if (!conn) throw new Error('The connection has ended.');
    await conn.write(new TextEncoder().encode(JSON.stringify({ token, ...action }) + '\n'));
  }).catch(() => status('The connection was lost. Ask ClikCode for a new link.'));
  return sendChain;
}
function showFrame(frame) {
  const raw = atob(frame.data);
  const bytes = Uint8Array.from(raw, char => char.charCodeAt(0));
  const next = URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }));
  if (imageUrl) URL.revokeObjectURL(imageUrl);
  imageUrl = next;
  $('screen').src = next;
  $('screen').style.display = 'block';
  $('controls').style.display = 'flex';
  status('Tap the browser, type, or finish this step.');
}
async function readFrames() {
  let pending = '';
  while (true) {
    const chunk = await conn.read();
    if (chunk === null) break;
    pending += new TextDecoder().decode(chunk);
    if (pending.length > 2_000_000) throw new Error('The browser frame is too large.');
    let end;
    while ((end = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      const message = JSON.parse(line);
      if (message.type === 'frame' && typeof message.data === 'string') showFrame(message);
      else if (message.type === 'done') { status('Done. ClikCode will continue.'); return; }
    }
  }
  status('This handoff ended. Return to ClikCode.');
}
$('screen').onclick = event => {
  const image = $('screen');
  const bounds = image.getBoundingClientRect();
  void send({ type: 'click', x: Math.round((event.clientX - bounds.left) * image.naturalWidth / bounds.width), y: Math.round((event.clientY - bounds.top) * image.naturalHeight / bounds.height) });
};
$('type').onclick = () => { void send({ type: 'type', text: $('entry').value }); $('entry').value = ''; };
$('enter').onclick = () => void send({ type: 'key', key: 'Enter' });
$('tab').onclick = () => void send({ type: 'key', key: 'Tab' });
$('up').onclick = () => void send({ type: 'scroll', direction: 'up' });
$('down').onclick = () => void send({ type: 'scroll', direction: 'down' });
$('done').onclick = () => { void send({ type: 'done' }); $('controls').style.display = 'none'; status('Finishing…'); };

async function start() {
  if (!addr?.startsWith('tc') || !/^[A-Za-z0-9_-]{43}$/.test(token ?? '') || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('This link is incomplete. Ask ClikCode for a new one.');
  const ready = new Promise(resolve => { globalThis.onTailcatReady = resolve; });
  const response = await fetch('main.wasm.gz');
  if (!response.ok) throw new Error('Could not load the handoff.');
  const wasm = response.body.pipeThrough(new DecompressionStream('gzip'));
  const go = new Go();
  WebAssembly.instantiateStreaming(new Response(wasm, { headers: { 'content-type': 'application/wasm' } }), go.importObject)
    .then(({ instance }) => go.run(instance));
  await ready;
  status('Connecting securely…');
  conn = await tailcatDial({ addr, derpMapURL: 'https://tailcat.dev/derpmap.json', port });
  await send({ type: 'hello' });
  await readFrames();
}
start().catch(() => status('Could not connect. Ask ClikCode for a new handoff link.'));
window.addEventListener('pagehide', () => { if (imageUrl) URL.revokeObjectURL(imageUrl); conn?.close(); });
