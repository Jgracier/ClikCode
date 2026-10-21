#!/usr/bin/env node
/** The `clikcode` a FAKE remote machine gets from fake-remote.mjs's repository:
 * just enough of ClikCode for ClikCode Remote to install, check and watch.
 *
 *   --version              1.0.0
 *   remote-info            {version, commit, installationId}
 *   ide-bridge --stdio     the multiplexed bridge protocol as JSON lines:
 *                          host-ready, a chat's ready, `query conversations`
 *                          from ~/.fake-remote/chats.json, opening one,
 *                          `conversations-changed` when that file changes
 *
 * ~/.fake-remote/later.json ({afterMs, chats}) replaces the list that long
 * after the first connection starts watching.
 *
 * Every request it gets is logged to ~/.fake-remote/bridge.log, so a test
 * can check which requests the board and opened chat sent.
 *
 * It owns its chats' folders as the real one does (session/attach.ts): a
 * chat is opened in a folder of THIS machine -- $FAKE_MACHINE, set by
 * fake-ssh.mjs, since the fake machines share the client's filesystem --
 * and one named elsewhere (a chat's `workspace` in chats.json, or an open's)
 * is its home instead, said as a warning notice. */
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, unlinkSync, watchFile, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, sep } from 'node:path';
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
const machineRoot = process.env.FAKE_MACHINE;
const machineName = process.env.FAKE_MACHINE_NAME || 'this machine';
const onThisMachine = (path) => {
  if (!path || (machineRoot && path !== machineRoot && !path.startsWith(`${machineRoot}${sep}`))) return false;
  try { return statSync(path).isDirectory(); } catch { return false; }
};
const chats = () => { try { return JSON.parse(read(join(fake, 'chats.json')) || '[]'); } catch { return []; } };

const [command, flag] = process.argv.slice(2);
if (command === '--version') { console.log('1.0.0'); process.exit(0); }
if (command === 'remote-info') { console.log(JSON.stringify({ version: '1.0.0', ...(commit ? { commit } : {}), installationId })); process.exit(0); }
if (command !== 'ide-bridge' || flag !== '--stdio') { console.error(`fake clikcode: ${process.argv.slice(2).join(' ')}`); process.exit(1); }

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
send({ type: 'host-ready', version: '1.0.0', protocol: 1, revision: 2, pid: process.pid, ...(commit ? { commit } : {}), installationId });
let watching = false;
const opened = new Map();
const sessions = new Map();
const choices = new Map();
const sessionFor = (id) => {
  let session = sessions.get(id);
  if (!session) {
    session = { id, route: 'local', accountId: null, provider: 'Grok Build', model: 'grok-4', effort: 'medium',
      name: chats().find((chat) => chat.id === id)?.title ?? 'Remote chat', createdAt: '', updatedAt: '', status: 'active', messages: [] };
    sessions.set(id, session);
  }
  return session;
};
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
  } else if (request.type === 'open' && request.mode === 'resume' && chats().some((chat) => chat.id === request.sessionId)) {
    opened.set(message.chat, request.sessionId);
    const session = sessionFor(request.sessionId);
    const saved = chats().find((chat) => chat.id === request.sessionId)?.workspace;
    session.workspace = onThisMachine(saved) ? saved : home;
    send({ type: 'chat', chat: message.chat, event: { type: 'session', session } });
    if (saved && session.workspace !== saved) {
      send({ type: 'chat', chat: message.chat, event: { type: 'notice', level: 'warning', message: `The folder ${saved} does not exist on ${machineName}; this chat continues in ${home}.` } });
    }
    send({ type: 'chat', chat: message.chat, event: { type: 'result', requestId: request.requestId, ok: true, data: { sessionId: request.sessionId } } });
  } else if (request.type === 'send' && opened.has(message.chat)) {
    const id = opened.get(message.chat);
    const session = sessionFor(id);
    if (request.text === '/provider') {
      choices.set(message.chat, request.id);
      send({ type: 'chat', chat: message.chat, event: { type: 'ui-request', id: 'provider-choice', request: {
        kind: 'pick', title: 'Choose a provider', canGoBack: false,
        items: [{ label: 'Grok Build' }, { label: 'Claude Code' }],
      } } });
      return;
    }
    session.messages.push({ role: 'user', content: request.text }, { role: 'assistant', content: 'Remote answer received.' });
    send({ type: 'chat', chat: message.chat, event: { type: 'turn-start', sessionId: id, prompt: request.text } });
    send({ type: 'chat', chat: message.chat, event: { type: 'worker', sessionId: id, event: { type: 'delta', text: 'Remote answer received.', mode: 'append' } } });
    send({ type: 'chat', chat: message.chat, event: { type: 'worker', sessionId: id, event: { type: 'snapshot', session, account: undefined } } });
    send({ type: 'chat', chat: message.chat, event: { type: 'worker', sessionId: id, event: { type: 'waiting-stop' } } });
    send({ type: 'chat', chat: message.chat, event: { type: 'send-complete', id: request.id } });
  } else if (request.type === 'ui-response' && request.id === 'provider-choice' && choices.has(message.chat)) {
    const session = sessionFor(opened.get(message.chat));
    session.provider = request.result.index === 1 ? 'Claude Code' : 'Grok Build';
    send({ type: 'chat', chat: message.chat, event: { type: 'session', session } });
    send({ type: 'chat', chat: message.chat, event: { type: 'send-complete', id: choices.get(message.chat) } });
    choices.delete(message.chat);
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
