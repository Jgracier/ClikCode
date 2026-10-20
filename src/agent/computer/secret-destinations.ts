/** Where a captured key can go: a name for a command, nothing more.
 *
 * A destination is a command line with slots: `{{secret}}` is where the key goes,
 * `{{anything-else}}` is filled by the agent (`send_to: [{ to: "clikdeploy-secret",
 * with: { key: "SALAD_API_KEY" } }]`). The key is put in by the worker at the
 * moment of capture, so it is in nothing the agent writes or reads.
 *
 * Nothing is built in. A handful of destinations ship as plain data below, and the
 * user adds their own with one line (`clikcode computer destination add`), kept in
 * `computer/destinations.json`. The agent cannot add or change one, so what can ever
 * run is decided by the user, not by a page the agent happens to be reading. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { runCli } from './run-cli.js';
import { namedSecretNames, readNamedSecret } from './credential-vault.js';
import { scrubSecrets } from './secret-scrubber.js';

export type Destination = { to: string; with?: Record<string, string> };
/** `vaultSlots`: slots whose value may be `secret:<saved name>`, read from the vault when it is sent, so the agent
 * never sees it. For a value that is not a secret but looks like one to every filter (an OAuth client id). */
type Template = { run: string[]; stdin?: string; about?: string; vaultSlots?: string[] };

/** `{{secret|json}}` is the key as it must sit inside a JSON string. */
const JSON_ARGS = (fields: string): string => `{${fields}}`;

export const DEFAULT_DESTINATIONS: Readonly<Record<string, Template>> = {
  'clikdeploy-secret': { about: 'a ClikDeploy platform secret (key)',
    run: ['clikdeploy', 'tools', 'run', 'admin_platform_set_secret', '--args-json', JSON_ARGS('"key":"{{key}}","value":"{{secret|json}}"'), '--confirm'] },
  'clikdeploy-app-secret': { about: 'a ClikDeploy app secret (app, key)',
    run: ['clikdeploy', 'tools', 'run', 'set_secret', '--args-json', JSON_ARGS('"appId":"{{app}}","key":"{{key}}","value":"{{secret|json}}"'), '--confirm'] },
  'clikdeploy-compute': { about: 'one field of a ClikDeploy compute provider card (provider, field)',
    run: ['clikdeploy', 'tools', 'run', 'admin_compute_save_credentials', '--args-json', JSON_ARGS('"provider":"{{provider}}","credentials":{"{{field}}":"{{secret|json}}"}'), '--confirm'] },
  // The secret is the OAuth client secret; the client id is not one and is a slot. Adding needs only the admin's
  // API key (the CLI's own sign-in): no code and no password, as long as the connector has no client stored.
  'clikdeploy-connector': { about: "a ClikDeploy connector's OAuth app (integration, client_id); the key is its client secret; client_id may be secret:<saved name>", vaultSlots: ['client_id'],
    run: ['clikdeploy', 'tools', 'run', 'admin_platform_save_connector_credentials', '--args-json', JSON_ARGS('"integrationId":"{{integration}}","clientId":"{{client_id}}","clientSecret":"{{secret|json}}"'), '--confirm'] },
  // A vendor key becomes a ClikDeploy connection for the signed-in account (the CLI's own sign-in): the same capability the product's
  // Connect button uses, so the key is probed before it is stored and never passes through the agent. The connector must exist and be enabled.
  'clikdeploy-connection': { about: "a ClikDeploy connector connection from an API key (integration)", run: ['clikdeploy', 'tools', 'run', 'connect_connector', '--args-json', JSON_ARGS('"integrationId":"{{integration}}","apiKey":"{{secret|json}}"'), '--confirm'] },
  // The username is an identifier, not a secret, but a vendor may hide it from the browser like one (Mux's token id): it may be given as secret:<saved name> and is read from the vault without being shown.
  'clikdeploy-connection-basic': { about: "a ClikDeploy connector connection from a username and the secret as its password (integration, username; username may be secret:<saved name>)", vaultSlots: ['username'], run: ['clikdeploy', 'tools', 'run', 'connect_connector', '--args-json', JSON_ARGS('"integrationId":"{{integration}}","username":"{{username}}","password":"{{secret|json}}"'), '--confirm'] },
  'github-secret': { about: 'a GitHub repository secret (repo, key)', run: ['gh', 'secret', 'set', '{{key}}', '--repo', '{{repo}}'], stdin: '{{secret}}' },
};

/** A plan in whatever honest shape the agent gave it: a list, one {to, with}, or just a name. */
export function normalizeSendTo(value: unknown): Destination[] | undefined {
  if (Array.isArray(value)) return value as Destination[];
  // A harness whose cached schema lacks a nested argument can hand it over as JSON text.
  if (typeof value === 'string' && /^\s*[[{]/.test(value)) { try { return normalizeSendTo(JSON.parse(value)); } catch { return undefined; } }
  if (typeof value === 'string' && value) return [{ to: value }];
  if (value && typeof value === 'object') return [value as Destination];
  return undefined;
}

const EXAMPLE = 'Example: {"to":"clikdeploy-secret","with":{"key":"SALAD_API_KEY"}}';

const NAME = /^[a-z][a-z0-9-]{1,40}$/;
/** A slot value goes into a command line: no quotes, no leading dash that a program could read as a flag. */
const SAFE_VALUE = /^[A-Za-z0-9_][\w.@:/ -]{0,119}$/;
const VAULT_REF = /^secret:([A-Za-z0-9][\w./-]{0,80})$/;
const SLOT = /\{\{([a-z][a-z0-9_]*)(\|json)?\}\}/g;

export const destinationsFile = (stateDir: string): string => path.join(stateDir, 'computer', 'destinations.json');

export async function loadDestinations(stateDir: string): Promise<Record<string, Template>> {
  let own: Record<string, Template> = {};
  try { own = JSON.parse(await fs.readFile(destinationsFile(stateDir), 'utf8')) as Record<string, Template>; } catch { /* none added yet */ }
  return { ...DEFAULT_DESTINATIONS, ...own };
}

/** The slots a template asks the agent to fill (everything but the key). */
export function slotsOf(template: Template): string[] {
  const text = [...template.run, template.stdin ?? ''].join('\n');
  return [...new Set([...text.matchAll(SLOT)].map(match => match[1]!))].filter(slot => slot !== 'secret');
}
const carriesSecret = (template: Template): boolean => [...template.run, template.stdin ?? ''].some(part => part.includes('{{secret}}') || part.includes('{{secret|json}}'));

export async function addDestination(stateDir: string, name: string, template: Template): Promise<void> {
  if (!NAME.test(name)) throw new Error('A destination name is lower-case letters, digits and dashes, such as my-vault.');
  if (!template.run.length || !template.run[0]) throw new Error('A destination needs a command to run.');
  if (!carriesSecret(template)) throw new Error('A destination needs {{secret}} in its command (or its stdin), or the key is never sent.');
  let own: Record<string, Template> = {};
  try { own = JSON.parse(await fs.readFile(destinationsFile(stateDir), 'utf8')) as Record<string, Template>; } catch { /* first one */ }
  own[name] = template;
  await fs.mkdir(path.dirname(destinationsFile(stateDir)), { recursive: true, mode: 0o700 });
  await fs.writeFile(destinationsFile(stateDir), `${JSON.stringify(own, null, 2)}\n`, { mode: 0o600 });
}

export async function removeDestination(stateDir: string, name: string): Promise<boolean> {
  let own: Record<string, Template> = {};
  try { own = JSON.parse(await fs.readFile(destinationsFile(stateDir), 'utf8')) as Record<string, Template>; } catch { return false; }
  if (!(name in own)) return false;
  delete own[name];
  await fs.writeFile(destinationsFile(stateDir), `${JSON.stringify(own, null, 2)}\n`, { mode: 0o600 });
  return true;
}

export const describeKnown = (all: Readonly<Record<string, Template>>): string =>
  Object.entries(all).map(([name, template]) => `${name}${slotsOf(template).length ? `(${slotsOf(template).join(', ')})` : ''}${template.about ? ` - ${template.about}` : ''}`).join('; ');

/** The first problem with the plan, in words the agent can act on; undefined when it is sound. */
export async function destinationProblem(stateDir: string, list: readonly unknown[]): Promise<string | undefined> {
  const all = await loadDestinations(stateDir);
  for (const [index, item] of list.entries()) {
    const at = `send_to[${index}]`;
    const d = item as Destination | null;
    if (!d || typeof d !== 'object' || typeof d.to !== 'string') return `${at} needs {to: "<destination>", with: {...}}. ${EXAMPLE}`;
    const template = all[d.to];
    if (!template) return `${at}: no destination named "${d.to}". Known: ${describeKnown(all)}. The user adds more with \`clikcode computer destination add\`. ${EXAMPLE}`;
    const saved = template.vaultSlots?.length ? await namedSecretNames(stateDir).catch(() => [] as string[]) : [];
    for (const slot of slotsOf(template)) {
      const value = d.with?.[slot];
      const ref = typeof value === 'string' && template.vaultSlots?.includes(slot) ? VAULT_REF.exec(value) : null;
      if (ref) {
        if (!saved.includes(ref[1]!)) return `${at}: with.${slot} names a saved secret "${ref[1]}" that is not in the Secrets Manager.`;
        continue;
      }
      if (typeof value !== 'string' || !SAFE_VALUE.test(value)) return `${at}: "${d.to}" needs with.${slot} (letters, digits, dot, dash, underscore, slash; not starting with a dash). ${EXAMPLE}`;
    }
  }
  return undefined;
}

/** One pass, so a key that happens to contain {{...}} text is never read as a slot. */
function fill(text: string, params: Record<string, string>, secret: string): string {
  return text.replace(SLOT, (_all, slot: string, json?: string) => slot === 'secret' ? (json ? JSON.stringify(secret).slice(1, -1) : secret) : params[slot] ?? '');
}

export type Delivery = { label: string; ok: boolean; message: string };

const say = (text: string): string => {
  try {
    const parsed = JSON.parse(text.slice(text.indexOf('{'))) as { message?: string; error?: string | { message?: string; code?: string }; data?: { message?: string; appliedToWebProcess?: boolean; reloadReason?: string } };
    const failure = typeof parsed.error === 'object' ? parsed.error.message ?? parsed.error.code : parsed.error;
    const line = [parsed.message ?? failure ?? parsed.data?.message, parsed.data?.appliedToWebProcess !== undefined ? `appliedToWebProcess=${parsed.data.appliedToWebProcess}` : '', parsed.data?.reloadReason].filter(Boolean).join(' · ');
    if (line) return line;
  } catch { /* not JSON: use the last lines */ }
  return text.trim().split('\n').slice(-3).join(' ').slice(0, 300);
};

export async function sendToDestinations(stateDir: string, list: readonly Destination[], value: string, signal?: AbortSignal): Promise<Delivery[]> {
  const all = await loadDestinations(stateDir);
  const out: Delivery[] = [];
  for (const d of list) {
    const template = all[d.to]!;
    const given = d.with ?? {};
    const label = `${d.to}${Object.keys(given).length ? ` (${Object.values(given).join(', ')})` : ''}`;
    // A vault slot is read here, at the last moment: the agent only ever named the secret.
    const params: Record<string, string> = {};
    let unreadable: string | undefined;
    for (const [slot, raw] of Object.entries(given)) {
      const ref = template.vaultSlots?.includes(slot) ? VAULT_REF.exec(raw) : null;
      if (!ref) { params[slot] = raw; continue; }
      const stored = (await readNamedSecret(stateDir, ref[1]!).catch(() => '')).trim();
      if (!stored || !SAFE_VALUE.test(stored)) { unreadable = `The saved secret "${ref[1]}" is missing or is not a plain id, so ${slot} could not be filled.`; break; }
      params[slot] = stored;
    }
    if (unreadable) { out.push({ label, ok: false, message: unreadable }); continue; }
    const [program, ...args] = template.run.map(part => fill(part, params, value));
    // A value goes to the program on stdin when the template says so: then it is in no command line.
    const result = await runCli(program!, args, { ...(template.stdin !== undefined ? { stdin: fill(template.stdin, params, value) } : {}), signal, timeoutMs: 90_000 });
    out.push(result.missing
      ? { label, ok: false, message: `The ${program} command is not installed on this computer.` }
      : { label, ok: result.code === 0, message: scrubSecrets(say(result.text)) });
  }
  return out;
}
