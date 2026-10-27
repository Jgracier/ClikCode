import { quiet } from '../runtime/lifecycle-log.js';
import { computerEnabled, generatedPasswordsAllowed, setComputerEnabled, setGeneratedPasswords } from '../agent/computer/settings.js';
import { stateDirectory } from '../session/store/paths.js';
import { emitResult } from '../cli/structured-output.js';
import { isJsonDefaultMode } from '../cli/output-mode.js';
import { closeComputerBrowser, closeComputerPage, frontComputerPage, releaseComputerBrowser } from '../agent/computer/browser.js';
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
    ? 'Generated passwords are on (the default): for a signup form the browser tool makes up a strong, unique password for that site, keeps it in Secrets Manager with the login, and never shows it. Turn off with `clikcode computer passwords off`.\n'
    : 'Generated passwords are off: a signup form uses the profile password if there is one, else asks you for the password privately. Turn on with `clikcode computer passwords on`.\n');
}

export async function computerUnattended(setting: string | undefined): Promise<void> {
  const { setUnattended, unattendedEnabled } = await import('../agent/computer/settings.js');
  const dir = stateDirectory();
  if (setting === 'on' || setting === 'off') await setUnattended(dir, setting === 'on');
  else if (setting) throw new Error('Say on or off: clikcode computer unattended on');
  const on = await unattendedEnabled(dir);
  if (isJsonDefaultMode()) return emitResult({ computer: { unattended: on } });
  process.stdout.write(on
    ? 'Unattended is on: a password, code or account choice the browser tool would ask you for is parked in the queue (needs-human, with the reason) and the agent goes on to the next vendor. See them with `clikcode computer queue --status needs-human`.\n'
    : 'Unattended is off: the browser tool asks you privately. Turn on with `clikcode computer unattended on`.\n');
}

/** `clikcode computer headless on|off`: run ClikCode's browser with no window. A Linux computer with no display does this by itself. */
export async function computerHeadless(setting: string | undefined): Promise<void> {
  const { headlessSetting, setHeadless } = await import('../agent/computer/settings.js');
  const dir = stateDirectory();
  if (setting === 'on' || setting === 'off') { await setHeadless(dir, setting === 'on'); await closeComputerBrowser(dir); }
  else if (setting) throw new Error('Say on or off: clikcode computer headless on');
  const on = await headlessSetting(dir);
  if (isJsonDefaultMode()) return emitResult({ computer: { headless: on } });
  process.stdout.write(on
    ? 'Headless is on: ClikCode\'s browser runs with no window. Turn off with `clikcode computer headless off`.\n'
    : 'Headless is off: ClikCode\'s browser opens a window (Linux with no display, or CLIKCODE_BROWSER_HEADLESS=1, still runs without one). Turn on with `clikcode computer headless on`.\n');
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
  } finally { await page.context().browser()?.close().catch(quiet('commands/computer')); }
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

/** `clikcode computer preflight`: the machine's readiness for onboarding work, as JSON (for an agent or a scheduled check). */
export async function computerPreflight(options: { post?: boolean } = {}): Promise<void> {
  const { runPreflightHere } = await import('../agent/computer/preflight.js');
  const result = await runPreflightHere(stateDirectory(), { post: options.post !== false });
  if (isJsonDefaultMode()) emitResult({ computer: { preflight: result } });
  else process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}

/** Remove saved logins for a site without a prompt or a chat; only the count is printed. */
export async function computerLoginsRemove(site: string, account?: string): Promise<void> {
  const { forgetSavedLogins } = await import('../agent/computer/credential-vault.js');
  const removed = await forgetSavedLogins(stateDirectory(), site, account);
  if (isJsonDefaultMode()) return emitResult({ computer: { removed, site } });
  process.stdout.write(removed ? `Removed ${removed} saved login${removed === 1 ? '' : 's'} for ${site}.\n` : `No saved login for ${site}.\n`);
}

/** The vault's saved secrets, by name only: no chat or worker is needed to look at your own files. */
export async function computerSecrets(remove?: string, backfill?: { owner?: string }, backup?: { export?: string; import?: string; overwrite?: boolean }): Promise<void> {
  if (backup?.export || backup?.import) return computerSecretsBackup(backup);
  const { deleteNamedSecret } = await import('../agent/computer/credential-vault.js');
  const stateDir = stateDirectory();
  if (remove) {
    const removed = await deleteNamedSecret(stateDir, remove);
    if (isJsonDefaultMode()) return emitResult({ computer: { deleted: removed, name: remove } });
    process.stdout.write(removed ? `Deleted "${remove}".\n` : `No secret named "${remove}".\n`);
    return;
  }
  const { namedSecretInfo, backfillSecretMeta } = await import('../agent/computer/credential-vault.js');
  if (backfill) {
    const done = await backfillSecretMeta(stateDir, backfill.owner);
    if (isJsonDefaultMode()) return emitResult({ computer: { backfilled: done } });
    process.stdout.write(`Recorded a vendor${backfill.owner ? ' and owner' : ''} on ${done.length} secret${done.length === 1 ? '' : 's'}.\n`);
    return;
  }
  const info = await namedSecretInfo(stateDir);
  if (isJsonDefaultMode()) return emitResult({ computer: { secrets: info.map(item => item.name), details: info } });
  process.stdout.write(info.length ? `${info.map(({ name, meta }) => `  ${name}${meta ? `  (${[meta.vendor, meta.owner, meta.env, `saved ${meta.createdAt.slice(0, 10)}`, meta.rotatedAt ? `rotated ${meta.rotatedAt.slice(0, 10)}` : ''].filter(Boolean).join(', ')})` : ''}`).join('\n')}\n` : 'No secrets are saved.\n');
}

/** `--audit`: what is untidy in the vault, by name only. */
export async function computerVaultAudit(): Promise<void> {
  const { auditVault } = await import('../agent/computer/credential-vault.js');
  const audit = await auditVault(stateDirectory());
  if (isJsonDefaultMode()) return emitResult({ computer: { audit } });
  const lines = [
    `Twin names (one key saved under two spellings): ${audit.twins.length ? audit.twins.map(names => names.join(' = ')).join('; ') : 'none'}`,
    `Odd names (no vendor/, or dated or numbered): ${audit.oddNames.length ? audit.oddNames.join(', ') : 'none'}`,
    `No owner recorded: ${audit.noOwner.length} secret${audit.noOwner.length === 1 ? '' : 's'}${audit.noOwner.length ? ' (clikcode computer secrets --backfill --owner <email>)' : ''}`,
    `Logins the site rejected: ${audit.rejectedLogins.length ? audit.rejectedLogins.map(login => `${login.site} (${login.label})`).join(', ') : 'none'}`,
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

/** `--sync <user@host>`: both computers end up with every login, secret and profile of the two. */
export async function computerVaultSync(target: string): Promise<void> {
  const { syncVault, tailscaleTransport } = await import('../agent/computer/vault-sync.js');
  const result = await syncVault(stateDirectory(), tailscaleTransport(target));
  if (isJsonDefaultMode()) return emitResult({ computer: { synced: target, ...result } });
  process.stdout.write(`Synced with ${target}: it gained ${result.sent.added} secret${result.sent.added === 1 ? '' : 's'}, this computer gained ${result.received.added} and updated ${result.received.updated}.\n`);
}

/** The other end of `--sync`: reads the sender's vault on standard input, merges it, and answers with this vault as it was. */
export async function computerVaultExchange(): Promise<void> {
  const { exchangeVault } = await import('../agent/computer/vault-sync.js');
  let input = '';
  for await (const chunk of process.stdin) input += String(chunk);
  process.stdout.write(await exchangeVault(stateDirectory(), input));
}

/** `--export <file>` / `--import <file>`: an encrypted backup of the whole vault, under a passphrase typed hidden. A terminal is required, so the
 * passphrase never passes through an agent, a pipe or a log; nothing is printed but counts. */
async function computerSecretsBackup(backup: { export?: string; import?: string; overwrite?: boolean }): Promise<void> {
  if (backup.export && backup.import) throw new Error('Say --export or --import, not both.');
  if (!process.stdin.isTTY) throw new Error('A backup passphrase is typed hidden: run this in a terminal.');
  const { MIN_PASSPHRASE, readVaultBackup, writeVaultBackup } = await import('../agent/computer/vault-backup.js');
  const stateDir = stateDirectory();
  const { default: path } = await import('node:path');
  if (backup.export) {
    const file = path.resolve(backup.export);
    const { existsSync } = await import('node:fs');
    if (existsSync(file)) throw new Error(`${file} already exists; choose a new file name.`);
    const first = await readHidden(`Backup passphrase (at least ${MIN_PASSPHRASE} characters, typed hidden): `);
    if (first !== await readHidden('Again: ')) throw new Error('The two passphrases differ. Nothing was written.');
    const counts = await writeVaultBackup(stateDir, file, first);
    if (isJsonDefaultMode()) return emitResult({ computer: { exported: file, ...counts } });
    process.stdout.write(`Wrote ${file}: ${counts.logins} login${counts.logins === 1 ? '' : 's'}, ${counts.secrets} secret${counts.secrets === 1 ? '' : 's'}, ${counts.records} other record${counts.records === 1 ? '' : 's'}. Keep the passphrase; without it the file cannot be opened.\n`);
    return;
  }
  const passphrase = await readHidden('Backup passphrase (typed hidden): ');
  const result = await readVaultBackup(stateDir, path.resolve(backup.import!), passphrase, { ...(backup.overwrite ? { overwrite: true } : {}) });
  if (isJsonDefaultMode()) return emitResult({ computer: { imported: backup.import, ...result } });
  process.stdout.write(`Restored ${result.added} item${result.added === 1 ? '' : 's'}${result.skipped ? `; ${result.skipped} already here ${backup.overwrite ? '' : 'were kept (use --overwrite to replace them)'}` : ''}.\n`);
}

/** Autofill profiles: list them, set fields (`--set phone=719-555-0123`), pick one with `--label`, or `--delete` by label. */
const PROFILE_QUESTIONS: readonly [string, string][] = [['given_name', 'First name'], ['family_name', 'Last name'], ['email', 'Email'], ['phone', 'Phone (with area code)'], ['address_line1', 'Street address'], ['address_line2', 'Apartment / suite (Enter to skip)'], ['city', 'City'], ['state', 'State'], ['postal_code', 'Zip / postal code'], ['country', 'Country'], ['organization', 'Company (Enter to skip)']];

export async function computerProfile(options: { label?: string; set?: string[]; custom?: string[]; delete?: string; create?: boolean; secret?: string }): Promise<void> {
  const { defaultProfile, describeProfile, listProfiles, removeProfile, saveProfile, saveProfileSecret } = await import('../agent/computer/profiles.js');
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
    const target = options.label ? profiles.find(profile => profile.label.toLowerCase() === options.label!.toLowerCase()) : defaultProfile(profiles);
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

/** The vendor set-up queue: list it, or record a task. */
export async function computerQueue(options: { status?: string; reason?: string; set?: string; vendor?: string; kind?: string; note?: string; owner?: string; importLedger?: string }): Promise<void> {
  const { describeTask, listTasks, saveTask, summarizeTasks } = await import('../agent/computer/work-queue.js');
  const stateDir = stateDirectory();
  if (options.importLedger) {
    const { readFile } = await import('node:fs/promises');
    const ledger = JSON.parse(await readFile(options.importLedger, 'utf8')) as Record<string, { ids?: string[]; status?: string; note?: string }>;
    const map: Record<string, string> = { done: 'done', blocked: 'blocked', 'no-self-serve': 'no-self-serve', 'todo-capture': 'queued' };
    let count = 0;
    for (const [vendor, entry] of Object.entries(ledger)) {
      await saveTask(stateDir, { vendor, kind: 'oauth-app', status: (map[entry.status ?? ''] ?? 'queued') as never, ...(entry.note ? { note: entry.note } : {}), ...(entry.ids?.length ? { connectors: entry.ids } : {}) });
      count++;
    }
    return void process.stdout.write(`Imported ${count} vendors into the queue.\n`);
  }
  if (options.set) {
    if (!options.vendor) throw new Error('Say which vendor: --vendor <name>.');
    const saved = await saveTask(stateDir, { vendor: options.vendor, status: options.set as never, ...(options.kind ? { kind: options.kind as never } : {}), ...(options.reason ? { reason: options.reason as never } : {}), ...(options.note ? { note: options.note } : {}), ...(options.owner ? { owner: options.owner } : {}) });
    return void process.stdout.write(`Recorded. ${describeTask(saved)}\n`);
  }
  const all = await listTasks(stateDir, { ...(options.status ? { status: options.status as never } : {}), ...(options.reason ? { reason: options.reason as never } : {}) });
  if (isJsonDefaultMode()) return emitResult({ computer: { tasks: all } });
  process.stdout.write(`${summarizeTasks(all)}\n${all.map(describeTask).join('\n')}\n`);
}

/** Ask ClikDeploy whether its current spec has current full proof, and keep that answer in the local queue. */
export async function computerConnectorProof(id: string): Promise<void> {
  const { syncConnectorProof } = await import('../agent/computer/connector-proof.js');
  const { proof, task } = await syncConnectorProof(stateDirectory(), id);
  if (isJsonDefaultMode()) return emitResult({ computer: { connectorProof: proof, task } });
  const left = proof.missing?.length ? proof.missing.map((m) => `  - ${m.item}: ${m.fix}`).join('\n') : proof.problems.map((p) => `  - ${p}`).join('\n');
  const finished = proof.done?.length ? `\nFinished: ${proof.done.join(', ')}` : '';
  process.stdout.write(`${id}: ${proof.ready ? 'finished' : 'not finished'}${proof.coverage ? ` (${proof.coverage.passing}/${proof.coverage.total} live checks)` : ''}${finished}\n${left ? `Left to do:\n${left}\n` : ''}${proof.next ? `Next: ${proof.next}\n` : ''}`);
}

/** `clikcode computer email connect|status|disconnect`: the mailbox the browser tool reads emailed codes and links from. */
export async function computerEmail(action: 'connect' | 'status' | 'disconnect'): Promise<void> {
  const dir = stateDirectory();
  const { emailStatus, disconnectEmail } = await import('../agent/computer/email-api.js');
  if (action === 'disconnect') {
    const removed = await disconnectEmail(dir);
    return isJsonDefaultMode() ? emitResult({ email: { disconnected: removed } }) : void process.stdout.write(removed ? 'Mailbox disconnected.\n' : 'No mailbox was connected.\n');
  }
  if (action === 'connect') {
    const { connectEmail } = await import('../agent/computer/email-consent.js');
    const { openComputerPage } = await import('../agent/computer/browser.js');
    const { listProfiles } = await import('../agent/computer/profiles.js');
    const email = (await listProfiles(dir)).map(profile => profile.fields.sso_email).find(Boolean);
    const done = await connectEmail(dir, await openComputerPage(dir, 'email'), { email, progress: line => line && process.stdout.write(line) }).finally(async () => { await closeComputerPage(dir, 'email').catch(quiet('commands/computer')); await releaseComputerBrowser(dir); });
    return isJsonDefaultMode() ? emitResult({ email: { connected: true, address: done.email } }) : void process.stdout.write(`Mailbox connected${done.email ? `: ${done.email}` : ''}.\n`);
  }
  const status = await emailStatus(dir);
  if (isJsonDefaultMode()) return emitResult({ email: status });
  process.stdout.write(status.connected ? `Mailbox connected: ${status.email} (since ${status.connectedAt?.slice(0, 10)}).\n` : 'No mailbox connected. Run `clikcode computer email connect`.\n');
}

/** `clikcode computer oauth-connect <connector>`: connects a ClikDeploy connector by pressing through the vendor's consent in the ClikCode browser. */
export async function computerOauthConnect(connector: string): Promise<void> {
  const dir = stateDirectory();
  const { oauthConnect } = await import('../agent/computer/oauth-consent.js');
  const { openComputerPage } = await import('../agent/computer/browser.js');
  const { listProfiles } = await import('../agent/computer/profiles.js');
  const email = (await listProfiles(dir)).map(profile => profile.fields.sso_email).find(Boolean);
  const done = await oauthConnect(connector, await openComputerPage(dir, 'oauth'), { email, stateDir: dir, progress: line => line && process.stdout.write(line) }).finally(async () => { await closeComputerPage(dir, 'oauth').catch(quiet('commands/computer')); await releaseComputerBrowser(dir); });
  return isJsonDefaultMode() ? emitResult({ computer: { oauthConnect: { connector: done.connector, connected: true } } }) : void process.stdout.write(`Connected ${done.connector}: ClikDeploy shows an active connection.\n`);
}
