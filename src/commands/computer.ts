import { computerEnabled, generatedPasswordsAllowed, setComputerEnabled, setGeneratedPasswords } from '../agent/computer/settings.js';
import { stateDirectory } from '../session/store/paths.js';
import { emitResult } from '../cli/structured-output.js';
import { isJsonDefaultMode } from '../cli/output-mode.js';
import { closeComputerBrowser, frontComputerPage } from '../agent/computer/browser.js';
import { loginFields, loginFieldSummary, pageControls } from '../agent/computer/login-fields.js';
import { lockCredentialVault } from '../agent/computer/credential-vault.js';
import { randomUUID } from 'node:crypto';
import { WorkerClient } from '../worker/client.js';
import { listWorkerRecords } from '../worker/registry.js';
import { resolveChat } from './ai/harness.js';

export async function computerStatus(): Promise<void> {
  const enabled = await computerEnabled(stateDirectory());
  if (isJsonDefaultMode()) return emitResult({ computer: { enabled } });
  process.stdout.write(enabled
    ? 'Computer use is on. The agent can open URLs and control the desktop when a task needs it.\n'
    : 'Computer use is off. Run `clikcode computer on` to make it available.\n');
}

/** `clikcode computer passwords on|off`: may the browser tool make up and keep a strong password for a signup form. */
export async function computerGeneratedPasswords(setting: string | undefined): Promise<void> {
  const dir = stateDirectory();
  if (setting === 'on' || setting === 'off') await setGeneratedPasswords(dir, setting === 'on');
  else if (setting) throw new Error('Say on or off: clikcode computer passwords on');
  const allowed = await generatedPasswordsAllowed(dir);
  if (isJsonDefaultMode()) return emitResult({ computer: { generatedPasswords: allowed } });
  process.stdout.write(allowed
    ? 'Generated passwords are on: for a signup form the browser tool makes up a strong password, keeps it in Secrets Manager with the login, and never shows it.\n'
    : 'Generated passwords are off: a signup form asks you for the password privately. Turn on with `clikcode computer passwords on`.\n');
}

export async function computerSetEnabled(enabled: boolean): Promise<void> {
  await setComputerEnabled(stateDirectory(), enabled);
  if (!enabled) { await closeComputerBrowser(stateDirectory()); lockCredentialVault(stateDirectory()); }
  if (isJsonDefaultMode()) return emitResult({ computer: { enabled } });
  process.stdout.write(enabled
    ? 'Computer use is on. The agent can open URLs and control the desktop when a task needs it.\n'
    : 'Computer use is off for new ClikCode agent turns.\n');
}

/** Safe form metadata for a vendor agent. Never reads input values or takes a screenshot. */
export async function computerInspect(): Promise<void> {
  if (!await computerEnabled(stateDirectory())) throw new Error('Computer use is off.');
  const page = await frontComputerPage(stateDirectory());
  try {
    const site = new URL(page.url()).origin;
    const fields = await loginFields(page);
    const controls = await pageControls(page);
    if (isJsonDefaultMode()) return emitResult({ computer: { site, fields: fields.map(({ label, kind }) => ({ label, kind })), controls } });
    process.stdout.write(`${loginFieldSummary(site, fields, controls)}\n`);
  } finally { await page.context().browser()?.close().catch(() => undefined); }
}

/** Ask for a site's credentials in the attached chat panel. This command's
 * stdout carries status only; the UI answer goes directly to its worker. */
export async function computerLogin(chat?: string, options: { url?: string; newAccount?: boolean; manage?: boolean } = {}): Promise<void> {
  const { url, newAccount, manage } = options;
  const workerPid = Number(process.env.CLIKCODE_WORKER_PID);
  const fromTurn = Number.isSafeInteger(workerPid) && workerPid > 0
    ? (await listWorkerRecords()).find(record => record.pid === workerPid)?.sessionId
    : undefined;
  const sessionId = chat ? await resolveChat(chat) : fromTurn;
  if (!sessionId) throw new Error('Use `clikcode computer login --chat <chat>` from outside a ClikCode chat.');
  if (fromTurn && sessionId !== fromTurn) throw new Error('A running chat can request a private login only in its own chat.');
  const client = await WorkerClient.attach(sessionId);
  const id = randomUUID();
  try {
    const result = await new Promise<{ ok: boolean; message: string }>((resolve, reject) => {
      let timer = setTimeout(() => { done(); reject(new Error('This chat is still running an older ClikCode worker. Try again after its current turn finishes.')); }, 5_000);
      const done = (): void => { clearTimeout(timer); client.off('event', onEvent); client.off('close', onClose); };
      const onClose = (): void => { done(); reject(new Error('The ClikCode chat disconnected.')); };
      const onEvent = (event: import('../worker/protocol.js').WorkerEvent): void => {
        if (event.type === 'computer-login-started' && event.id === id) {
          clearTimeout(timer);
          timer = setTimeout(() => { done(); reject(new Error('The private login prompt expired.')); }, 10 * 60_000);
          return;
        }
        if (event.type !== 'computer-login-result' || event.id !== id) return;
        done(); resolve(event);
      };
      client.on('event', onEvent);
      client.on('close', onClose);
      client.send({ type: 'computer-login', id, ...(url ? { url } : {}), ...(newAccount ? { newAccount: true as const } : {}), ...(manage ? { manage: true as const } : {}) });
    });
    if (!result.ok) throw new Error(result.message);
    if (isJsonDefaultMode()) emitResult({ computer: { login: result.message } });
    else process.stdout.write(`${result.message}\n`);
  } finally { client.close(); }
}

/** Run one computer tool in the current chat's worker. For a harness with no MCP, a script,
 * or a person at a shell: the output is the same scrubbed status the MCP server returns. */
export async function computerTool(tool: string, args: Record<string, unknown>, chat?: string): Promise<void> {
  const { callWorkerTool } = await import('./computer-tool-client.js');
  const result = await callWorkerTool({ ...(chat ? { chat } : {}), tool, args });
  if (isJsonDefaultMode()) emitResult({ computer: { ok: result.ok, output: result.output } });
  else process.stdout.write(`${result.output}\n`);
  if (!result.ok) process.exitCode = 1;
}

/** The vault's saved secrets, by name only: no chat or worker is needed to look at your own files. */
export async function computerSecrets(remove?: string): Promise<void> {
  const { deleteNamedSecret, namedSecretNames } = await import('../agent/computer/credential-vault.js');
  const stateDir = stateDirectory();
  if (remove) {
    const removed = await deleteNamedSecret(stateDir, remove);
    if (isJsonDefaultMode()) return emitResult({ computer: { deleted: removed, name: remove } });
    process.stdout.write(removed ? `Deleted "${remove}".\n` : `No secret named "${remove}".\n`);
    return;
  }
  const names = await namedSecretNames(stateDir);
  if (isJsonDefaultMode()) return emitResult({ computer: { secrets: names } });
  process.stdout.write(names.length ? `${names.map(name => `  ${name}`).join('\n')}\n` : 'No secrets are saved.\n');
}

/** Autofill profiles: list them, set fields (`--set phone=719-555-0123`), pick one with `--label`, or `--delete` by label. */
const PROFILE_QUESTIONS: readonly [string, string][] = [['given_name', 'First name'], ['family_name', 'Last name'], ['email', 'Email'], ['phone', 'Phone (with area code)'], ['address_line1', 'Street address'], ['address_line2', 'Apartment / suite (Enter to skip)'], ['city', 'City'], ['state', 'State'], ['postal_code', 'Zip / postal code'], ['country', 'Country'], ['organization', 'Company (Enter to skip)']];

export async function computerProfile(options: { label?: string; set?: string[]; custom?: string[]; delete?: string; create?: boolean; secret?: string }): Promise<void> {
  const { describeProfile, listProfiles, removeProfile, saveProfile, saveProfileSecret } = await import('../agent/computer/profiles.js');
  const stateDir = stateDirectory();
  const emit = (text: string, data: unknown): void => { if (isJsonDefaultMode()) emitResult({ computer: { profiles: data } }); else process.stdout.write(`${text}\n`); };
  if (options.delete) {
    const target = (await listProfiles(stateDir)).find(profile => profile.label.toLowerCase() === options.delete!.toLowerCase());
    const removed = target ? await removeProfile(stateDir, target.id) : false;
    return emit(removed ? `Deleted "${options.delete}".` : `No profile named "${options.delete}".`, { deleted: removed });
  }
  if (options.create) {
    if (!process.stdin.isTTY) throw new Error('Creating a profile asks questions: run it in a terminal, or use --set key=value.');
    const { createInterface } = await import('node:readline/promises');
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    const label = options.label ?? ((await rl.question('Profile name [Personal]: ')).trim() || 'Personal');
    const fields: Record<string, string> = {};
    for (const [key, question] of PROFILE_QUESTIONS) { const answer = (await rl.question(`${question}: `)).trim(); if (answer) fields[key] = answer; }
    rl.close();
    const saved = await saveProfile(stateDir, { label, fields });
    return emit(`Saved. ${describeProfile(saved)}`, [saved]);
  }
  if (options.secret) {
    if (!process.stdin.isTTY) throw new Error('A secret is typed hidden: run this in a terminal.');
    const profiles = await listProfiles(stateDir);
    const target = options.label ? profiles.find(profile => profile.label.toLowerCase() === options.label!.toLowerCase()) : profiles.length === 1 ? profiles[0] : undefined;
    if (!target) throw new Error(options.label ? `No profile named "${options.label}".` : 'Say which profile: --label <name>.');
    const value = await readHidden(`${options.secret} for "${target.label}" (typed hidden): `);
    await saveProfileSecret(stateDir, target.id, options.secret, value);
    return emit(`Saved. ${describeProfile((await listProfiles(stateDir)).find(profile => profile.id === target.id) ?? target)}`, { saved: options.secret });
  }
  if (options.set?.length) {
    const fields = Object.fromEntries(options.set.map(pair => { const at = pair.indexOf('='); if (at < 1) throw new Error(`Use key=value, for example phone=719-555-0123 (got "${pair}").`); return [pair.slice(0, at), pair.slice(at + 1)]; }));
    const saved = await saveProfile(stateDir, { ...(options.label ? { label: options.label } : {}), fields });
    return emit(`Saved. ${describeProfile(saved)}`, [saved]);
  }
  if (options.custom?.length) {
    const custom = Object.fromEntries(options.custom.map(pair => { const at = pair.indexOf('='); if (at < 1) throw new Error(`Use key=value, for example app_name="My App" (got "${pair}").`); return [pair.slice(0, at).trim(), { value: pair.slice(at + 1) }]; }));
    const saved = await saveProfile(stateDir, { ...(options.label ? { label: options.label } : {}), fields: {}, custom });
    return emit(`Saved. ${describeProfile(saved)}`, [saved]);
  }
  const all = await listProfiles(stateDir);
  emit(all.length ? all.map(describeProfile).join('\n') : 'No profile is saved. Set one: clikcode computer profile --label Personal --set given_name=Ada --set phone=719-555-0123', all);
}

export async function computerDestinations(): Promise<void> {
  const { describeKnown, loadDestinations } = await import('../agent/computer/secret-destinations.js');
  const all = await loadDestinations(stateDirectory());
  if (isJsonDefaultMode()) return emitResult({ computer: { destinations: all } });
  process.stdout.write(`${describeKnown(all).split('; ').map(line => `  ${line}`).join('\n')}\n`);
}

export async function computerDestinationAdd(name: string, command: string[], options: { stdin?: string; about?: string }): Promise<void> {
  const { addDestination } = await import('../agent/computer/secret-destinations.js');
  await addDestination(stateDirectory(), name, { run: command, ...(options.stdin !== undefined ? { stdin: options.stdin } : {}), ...(options.about ? { about: options.about } : {}) });
  if (isJsonDefaultMode()) return emitResult({ computer: { destination: name, added: true } });
  process.stdout.write(`Added "${name}". The agent can now send keys there with send_to.\n`);
}

export async function computerDestinationRemove(name: string): Promise<void> {
  const { removeDestination } = await import('../agent/computer/secret-destinations.js');
  const removed = await removeDestination(stateDirectory(), name);
  if (isJsonDefaultMode()) return emitResult({ computer: { destination: name, removed } });
  process.stdout.write(removed ? `Removed "${name}".\n` : `"${name}" is not one you added.\n`);
}

/** One line typed without being echoed. */
async function readHidden(question: string): Promise<string> {
  const { createInterface } = await import('node:readline/promises');
  const { Writable } = await import('node:stream');
  let muted = false;
  const out = new Writable({ write(chunk, _encoding, done) { if (!muted) process.stderr.write(chunk); done(); } });
  const rl = createInterface({ input: process.stdin, output: out, terminal: true });
  const asked = rl.question(question);
  muted = true;
  const answer = await asked;
  rl.close();
  process.stderr.write('\n');
  return answer;
}
