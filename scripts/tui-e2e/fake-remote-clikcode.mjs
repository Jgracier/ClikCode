#!/usr/bin/env node
/** The `clikcode` a FAKE remote machine gets from fake-remote.mjs's repository:
 * just enough of ClikCode for ClikCode Remote to install, check and watch.
 *
 *   --version              1.0.0
 *   remote-info            {version, commit, installationId}
 *   ide-bridge --stdio     the multiplexed bridge protocol as JSON lines:
 *                          host-ready, a chat's ready, `query conversations`
 *                          from ~/.fake-remote/chats.json, and
 *                          `conversations-changed` when that file changes
 *
 * ~/.fake-remote/later.json ({afterMs, chats}) replaces the list that long
 * after the first connection starts watching.
 *
 * Every request it gets is logged to ~/.fake-remote/bridge.log, so a test
 * can check the board only ever asked to read. */
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync, watchFile, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';

const home = homedir();
const fake = join(home, '.fake-remote');
mkdirSync(fake, { recursive: true });
const read = (file) => { try { return readFileSync(file, 'utf8').trim(); } catch { return ''; } };
const commit = read(join(fake, 'commit')) || read(join(dirname(realpathSync(process.argv[1])), '..', 'commit'));
const installationId = (() => {
  const file = join(home, '.clikcode', 'fake-installation-id');
  if (!existsSync(file)) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, randomUUID()); }
  return read(file);
})();
const chats = () => { try { return JSON.parse(read(join(fake, 'chats.json')) || '[]'); } catch { return []; } };

const [command, flag] = process.argv.slice(2);
if (command === '--version') { console.log('1.0.0'); process.exit(0); }
if (command === 'remote-info') { console.log(JSON.stringify({ version: '1.0.0', ...(commit ? { commit } : {}), installationId })); process.exit(0); }
if (command !== 'ide-bridge' || flag !== '--stdio') { console.error(`fake clikcode: ${process.argv.slice(2).join(' ')}`); process.exit(1); }

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
send({ type: 'host-ready', version: '1.0.0', protocol: 1, revision: 2, pid: process.pid, ...(commit ? { commit } : {}), installationId });
let watching = false;
const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  appendFileSync(join(fake, 'bridge.log'), `${line}\n`);
  if (message.type === 'chat-attach') { send({ type: 'chat', chat: message.chat, event: { type: 'ready', version: '1.0.0', pid: process.pid } }); return; }
  if (message.type !== 'chat') return;
  const request = message.request;
  if (request.type === 'query' && request.query === 'conversations') {
    send({ type: 'chat', chat: message.chat, event: { type: 'result', requestId: request.requestId, ok: true, data: chats() } });
  } else if (request.type === 'watch-conversations' && request.on && !watching) {
    watching = true;
    watchFile(join(fake, 'chats.json'), { interval: 100 }, () => send({ type: 'chat', chat: message.chat, event: { type: 'conversations-changed' } }));
    // ~/.fake-remote/later.json, {afterMs, chats}: the list changes by itself
    // that long after the board starts watching (a turn starting there).
    const later = (() => { try { return JSON.parse(read(join(fake, 'later.json'))); } catch { return undefined; } })();
    // Once: the first connection that watches.
    if (later) {
      unlinkSync(join(fake, 'later.json'));
      setTimeout(() => writeFileSync(join(fake, 'chats.json'), JSON.stringify(later.chats)), later.afterMs ?? 1000);
    }
  }
});
lines.on('close', () => process.exit(0));
