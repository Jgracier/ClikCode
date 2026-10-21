#!/usr/bin/env node
/** A FAKE `ssh` for ClikCode Remote's tests: no network, no real machine.
 *
 * Put on PATH as `ssh`. Each "machine" is a directory made by
 * fake-remote.mjs under $FAKE_SSH_ROOT/hosts/<host>/: its `home` is the
 * remote $HOME, `bin` its PATH, and `config.json` how it behaves:
 *
 *   { "users": ["bob"] }   only these users may log in (else Permission denied)
 *   { "offline": true }    the connection times out
 *   { "windows": true }    the login shell is cmd.exe: `sh` is not recognized
 *
 * The remote command (everything after the target, joined by spaces as ssh
 * does) runs under /bin/sh -c in that HOME, with that HOME, USER, PWD and PATH
 * and nothing of the client's environment, stdio passed through.
 *
 * The two machines share one filesystem here, which a real pair does not: a
 * path of the client's would "exist" on the remote. So the remote's HOME must
 * be its own (never inside the client's HOME, nor the client's inside it), and
 * FAKE_MACHINE names the machine's directory: a path outside it is, for the
 * fake ClikCode there, not on that machine (fake-remote-clikcode.mjs).
 * `ssh -G host` prints `user <name>` from $FAKE_SSH_ROOT/ssh_config.json
 * ({"<host>": "<user>"}) or $USER, as real ssh reads ~/.ssh/config.
 * Every invocation's argv is appended to $FAKE_SSH_ROOT/ssh.log (JSON lines). */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, sep } from 'node:path';

const root = process.env.FAKE_SSH_ROOT;
if (!root) { process.stderr.write('fake ssh: FAKE_SSH_ROOT is not set\n'); process.exit(255); }
const argv = process.argv.slice(2);
appendFileSync(join(root, 'ssh.log'), `${JSON.stringify(argv)}\n`);

const WITH_VALUE = new Set(['-o', '-p', '-i', '-l', '-F', '-J', '-E', '-b', '-c', '-D', '-e', '-I', '-L', '-m', '-O', '-Q', '-R', '-S', '-W', '-w', '-B']);
let at = 0;
let printConfig = false;
let loginName;
while (at < argv.length) {
  const arg = argv[at];
  if (arg === '--') { at += 1; break; }
  if (!arg.startsWith('-')) break;
  if (arg === '-G') printConfig = true;
  if (arg === '-l') loginName = argv[at + 1];
  at += WITH_VALUE.has(arg) ? 2 : 1;
}
const target = argv[at];
const command = argv.slice(at + 1).join(' ');
if (!target) { process.stderr.write('usage: ssh destination [command]\n'); process.exit(255); }
if (target.startsWith('-')) { process.stderr.write(`fake ssh: target looks like an option: ${target}\n`); process.exit(254); }
const split = target.lastIndexOf('@');
const host = split >= 0 ? target.slice(split + 1) : target;
const configured = (() => {
  try { return JSON.parse(readFileSync(join(root, 'ssh_config.json'), 'utf8'))[host]; } catch { return undefined; }
})();
const user = split >= 0 ? target.slice(0, split) : loginName ?? configured ?? process.env.USER ?? 'nobody';

if (printConfig) {
  process.stdout.write(`user ${configured ?? process.env.USER ?? 'nobody'}\nhostname ${host}\nport 22\n`);
  process.exit(0);
}

const machine = join(root, 'hosts', host);
if (!existsSync(machine)) { process.stderr.write(`ssh: Could not resolve hostname ${host}: Name or service not known\n`); process.exit(255); }
const config = (() => { try { return JSON.parse(readFileSync(join(machine, 'config.json'), 'utf8')); } catch { return {}; } })();
if (config.offline) { process.stderr.write(`ssh: connect to host ${host} port 22: Connection timed out\n`); process.exit(255); }
if (Array.isArray(config.users) && !config.users.includes(user)) { process.stderr.write(`${user}@${host}: Permission denied (publickey).\n`); process.exit(255); }
if (config.windows) {
  process.stdout.write(`'${command.split(' ')[0]}' is not recognized as an internal or external command,\r\noperable program or batch file.\r\n`);
  process.exit(1);
}
const home = join(machine, 'home');
const inside = (path, folder) => Boolean(path && folder) && (path === folder || path.startsWith(`${folder}${sep}`));
if (inside(home, process.env.HOME) || inside(process.env.HOME, home)) {
  process.stderr.write(`fake ssh: ${host}'s HOME (${home}) and the client's (${process.env.HOME}) must be apart: two machines do not share a home\n`);
  process.exit(254);
}
const child = spawn('/bin/sh', ['-c', command || 'exit 0'], {
  stdio: 'inherit',
  cwd: home,
  env: {
    HOME: home, USER: user, LOGNAME: user, PWD: home, PATH: join(machine, 'bin'), TMPDIR: join(machine, 'tmp'), LANG: 'C',
    FAKE_MACHINE: machine, FAKE_MACHINE_NAME: host.split('.')[0], ...(config.env ?? {}),
  },
});
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 255 : 0)));
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => child.kill(signal));
