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
import { quiet } from '../../runtime/lifecycle-log.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runCli } from './run-cli.js';
import { cliReadsArgsJsonFromStdin } from './cli-stdin-support.js';
import { namedSecretNames, readNamedSecret } from './credential-vault.js';
import { scrubSecrets } from './secret-scrubber.js';

/** `connectionValues`: for the two ClikDeploy connection destinations, the per-account values a connector's base URL needs
 * ({app_id: "WJUQDEJ3SG"}); sent to ClikDeploy's connect route as `baseUrlVariables`. Not secrets. */
export type Destination = { to: string; with?: Record<string, string>; connectionValues?: Record<string, string> | string; /** The plain name of `connectionValues`. */ values?: Record<string, string> | string };
/** `vaultSlots`: slots whose value may be `secret:<saved name>`, read from the vault when it is sent, so the agent
 * never sees it. For a value that is not a secret but looks like one to every filter (an OAuth client id). */
type Template = { run: string[]; stdin?: string; about?: string; vaultSlots?: string[];
  /** Slots that may be left out (they are then empty), such as the blank password of a basic login whose key is the username. */
  optionalSlots?: string[];
  /** `connection`: success is not the command's word for it. After it runs, ClikDeploy is asked whether `integration` now has an active connection. */
  verify?: 'connection' };

/** `{{secret|json}}` is the key as it must sit inside a JSON string. */
const JSON_ARGS = (fields: string): string => `{${fields}}`;

export const DEFAULT_DESTINATIONS: Readonly<Record<string, Template>> = {
  'clikdeploy-secret': { about: 'a ClikDeploy platform secret (key)',
    run: ['clikdeploy', 'tools', 'run', 'admin_platform_set_secret', '--args-json', '-', '--confirm'], stdin: JSON_ARGS('"key":"{{key}}","value":"{{secret|json}}"') },
  'clikdeploy-app-secret': { about: 'a ClikDeploy app secret (app, key)',
    run: ['clikdeploy', 'tools', 'run', 'set_secret', '--args-json', '-', '--confirm'], stdin: JSON_ARGS('"appId":"{{app}}","key":"{{key}}","value":"{{secret|json}}"') },
  'clikdeploy-compute': { about: 'one field of a ClikDeploy compute provider card (provider, field)',
    run: ['clikdeploy', 'tools', 'run', 'admin_compute_save_credentials', '--args-json', '-', '--confirm'], stdin: JSON_ARGS('"provider":"{{provider}}","credentials":{"{{field}}":"{{secret|json}}"}') },
  // The secret is the OAuth client secret; the client id is not one and is a slot. Adding needs only the admin's
  // API key (the CLI's own sign-in): no code and no password, as long as the connector has no client stored.
  'clikdeploy-connector': { about: "a ClikDeploy connector's OAuth app (integration, client_id); the key is its client secret; client_id may be secret:<saved name>", vaultSlots: ['client_id'],
    run: ['clikdeploy', 'tools', 'run', 'admin_platform_save_connector_credentials', '--args-json', '-', '--confirm'], stdin: JSON_ARGS('"integrationId":"{{integration}}","clientId":"{{client_id}}","clientSecret":"{{secret|json}}"') },
  'clikdeploy-connection': { about: 'connect an API key to a ClikDeploy connector (integration) for the signed-in account; the result is `connected` or `NOT connected: <reason>`, read back from ClikDeploy', verify: 'connection',
    run: ['clikdeploy', 'tools', 'run', 'connect_connector', '--args-json', '-', '--confirm'], stdin: JSON_ARGS('"integrationId":"{{integration}}","apiKey":"{{secret|json}}"') },
  // Some vendors expose a token id as the basic-auth username. It can be read from the vault at send time.
  'clikdeploy-connection-basic': { about: 'connect a username and password to a ClikDeploy connector (integration, username; username may be secret:<saved name>); the result is `connected` or `NOT connected: <reason>`', vaultSlots: ['username'], verify: 'connection',
    run: ['clikdeploy', 'tools', 'run', 'connect_connector', '--args-json', '-', '--confirm'], stdin: JSON_ARGS('"integrationId":"{{integration}}","username":"{{username}}","password":"{{secret|json}}"') },
  // The vendor gives one key and it is the basic-auth username (BugHerd, HTML/CSS to Image): the password is blank unless one is given.
  'clikdeploy-connection-basic-key': { about: 'connect a key that is the basic-auth USERNAME to a ClikDeploy connector (integration; password optional, blank by default); the result is `connected` or `NOT connected: <reason>`', optionalSlots: ['password'], verify: 'connection',
    run: ['clikdeploy', 'tools', 'run', 'connect_connector', '--args-json', '-', '--confirm'], stdin: JSON_ARGS('"integrationId":"{{integration}}","username":"{{secret|json}}","password":"{{password}}"') },
  'github-secret': { about: 'a GitHub repository secret (repo, key)', run: ['gh', 'secret', 'set', '{{key}}', '--repo', '{{repo}}'], stdin: '{{secret}}' },
};

const CONNECTION_TO = new Set(['clikdeploy-connection', 'clikdeploy-connection-basic', 'clikdeploy-connection-basic-key']);
const CONNECTION_SLOTS = new Set(['integration', 'username', 'password']);

/** A plan in whatever honest shape the agent gave it: a list, one {to, with}, or just a name. */
export function normalizeSendTo(value: unknown): Destination[] | undefined {
  const plain = (item: Destination): Destination => {
    if (!item || typeof item !== 'object') return item;
    const { values, ...first } = item;
    let rest: Destination = first;
    let connectionValues = rest.connectionValues ?? values;
    // `with` of a connection destination holds only integration, username and password; any other name there is a connection value
    // (`--with org_api_key=...` on the command line has no other place to go).
    if (CONNECTION_TO.has(rest.to) && rest.with && typeof rest.with === 'object') {
      const slots: Record<string, string> = {}; const extra: Record<string, string> = {};
      for (const [name, v] of Object.entries(rest.with)) (CONNECTION_SLOTS.has(name) ? slots : extra)[name] = v;
      if (Object.keys(extra).length) {
        const given = typeof connectionValues === 'string' ? (() => { try { return JSON.parse(connectionValues as string) as Record<string, string>; } catch { return undefined; } })() : connectionValues;
        if (given && typeof given === 'object') { connectionValues = { ...extra, ...given }; rest = { ...rest, with: slots }; }
        else if (connectionValues === undefined) { connectionValues = extra; rest = { ...rest, with: slots }; }
      }
    }
    return connectionValues === undefined ? rest : { ...rest, connectionValues };
  };
  if (Array.isArray(value)) return (value as Destination[]).map(plain);
  // A harness whose cached schema lacks a nested argument can hand it over as JSON text.
  if (typeof value === 'string' && /^\s*[[{]/.test(value)) { try { return normalizeSendTo(JSON.parse(value)); } catch { return undefined; } }
  if (typeof value === 'string' && value) return [{ to: value }];
  if (value && typeof value === 'object') return [plain(value as Destination)];
  return undefined;
}

const EXAMPLE = 'Example: {"to":"clikdeploy-secret","with":{"key":"SALAD_API_KEY"}}';

const NAME = /^[a-z][a-z0-9-]{1,40}$/;
/** A slot value goes into a command line: no quotes, no leading dash that a program could read as a flag. */
const SAFE_VALUE = /^[A-Za-z0-9_][\w.@:/ -]{0,119}$/;
const VAULT_REF = /^secret:([A-Za-z0-9][\w./-]{0,80})$/;
const VALUE_NAME = /^[A-Za-z_][\w-]{0,40}$/;
const VALUE_TEXT = /^[A-Za-z0-9][\w.-]{0,119}$/;
const VALUE_FORMAT = 'letters, digits, dot, dash or underscore, no spaces, slashes or https://';

/** The connection values as a plain map, or the problem with them. A harness may hand the map over as JSON text. */
function readConnectionValues(raw: unknown): { values?: Record<string, string>; problem?: string } {
  if (raw === undefined || raw === null || raw === '') return {};
  let map: unknown = raw;
  if (typeof map === 'string') { try { map = JSON.parse(map) as unknown; } catch { return { problem: 'connectionValues must be a map such as {"app_id":"WJUQDEJ3SG"}.' }; } }
  if (!map || typeof map !== 'object' || Array.isArray(map)) return { problem: 'connectionValues must be a map such as {"app_id":"WJUQDEJ3SG"}.' };
  const values: Record<string, string> = {};
  for (const [name, value] of Object.entries(map as Record<string, unknown>)) {
    if (!VALUE_NAME.test(name)) return { problem: `connectionValues has a name "${name.slice(0, 41)}" that is not a plain identifier.` };
    if (typeof value === 'string' && VAULT_REF.test(value.trim())) { values[name] = value.trim(); continue; } // read from the vault when sent
    if (typeof value !== 'string' || !VALUE_TEXT.test(value.trim())) return { problem: `connectionValues.${name} must be ${VALUE_FORMAT}, or secret:<saved name> for a value saved earlier (read_value, capture_secret).` };
    values[name] = value.trim();
  }
  return { values };
}
const takesConnectionValues = (template: Template): boolean => template.verify === 'connection';

const SLOT = /\{\{([a-z][a-z0-9_]*)(\|json)?\}\}/g;

export const destinationsFile = (stateDir: string): string => path.join(stateDir, 'computer', 'destinations.json');

export async function loadDestinations(stateDir: string): Promise<Record<string, Template>> {
  let own: Record<string, Template> = {};
  try { own = JSON.parse(await fs.readFile(destinationsFile(stateDir), 'utf8')) as Record<string, Template>; } catch { /* none added yet */ }
  // A saved destination that connects a key through connect_connector is read back from ClikDeploy like the built-in ones: an older
  // saved copy of a built-in (written before `verify` existed) or a hand-made one must not fall through to a bare "delivered".
  const merged: Record<string, Template> = { ...DEFAULT_DESTINATIONS, ...own };
  for (const [name, template] of Object.entries(merged)) {
    if (template.verify || !template.run.includes('connect_connector') || !slotsOf(template).includes('integration')) continue;
    merged[name] = { ...template, verify: 'connection' };
  }
  return merged;
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

/** `required`: false for a value the connect call does not need (not in the base URL, or has a default, or the spec says optional). */
export type DeclaredValues = Record<string, { label?: string; description?: string; required?: boolean; optional?: boolean; default?: string }>;
/** The plain per-account values a connector's base URL declares (Knack app_id, Kommo subdomain), or undefined when that cannot be told. */
export async function declaredConnectionValues(integration: string, signal?: AbortSignal): Promise<DeclaredValues | undefined> {
  const shown = await runCli('clikdeploy', ['integrations', 'show', integration], { signal, timeoutMs: 30_000, maxChars: 4_000_000 });
  if (shown.missing) return undefined;
  const parsed = firstJsonObject<{ status?: string; data?: { proxy?: { base_url?: string; variables?: DeclaredValues } } }>(shown.text);
  const proxy = parsed?.status === 'error' ? undefined : parsed?.data?.proxy;
  if (!proxy || typeof proxy !== 'object') return undefined;
  const variables = proxy.variables && typeof proxy.variables === 'object' ? proxy.variables : {};
  // ClikDeploy's connect route demands a value only for a variable in the base URL that has no default; any other declared value is optional.
  const template = typeof proxy.base_url === 'string' ? proxy.base_url : '';
  return Object.fromEntries(Object.entries(variables).map(([name, v]) => [name, { ...v, required: !v.optional && v.default === undefined && template.includes(`{${name}}`) }]));
}

/** The connection destinations that fit each auth kind a connector declares. */
const ACCEPTS: Record<string, string[]> = { 'api-key': ['clikdeploy-connection'], basic: ['clikdeploy-connection-basic', 'clikdeploy-connection-basic-key'], custom: [], oauth: ['clikdeploy-connection'] };

/** One message listing the shapes a connector's declared auth accepts. */
export function describeShapes(integration: string, kind: string): string {
  const shapes: Record<string, string> = {
    'api-key': `{"to":"clikdeploy-connection","with":{"integration":"${integration}"}} (the captured key is the API key)`,
    oauth: `{"to":"clikdeploy-connection","with":{"integration":"${integration}"}} (the captured key is a token; the connector may prefer oauth_connect)`,
    basic: `{"to":"clikdeploy-connection-basic","with":{"integration":"${integration}","username":"<name or secret:<saved name>>"}} (the captured key is the PASSWORD), or {"to":"clikdeploy-connection-basic-key","with":{"integration":"${integration}"}} (the captured key is the USERNAME; add "password" for a fixed one, else blank)`,
    custom: 'a custom-auth connector takes named props, which capture_secret cannot send; connect it in ClikDeploy',
  };
  return `${integration} declares ${kind} auth. Accepted: ${shapes[kind] ?? `none of the known shapes (auth kind "${kind}")`}.`;
}

/** The auth kind a connector declares (api-key, basic, custom, oauth), or undefined when it cannot be told. */
export async function declaredAuthKind(integration: string, signal?: AbortSignal): Promise<string | undefined> {
  const shown = await runCli('clikdeploy', ['integrations', 'show', integration], { signal, timeoutMs: 30_000, maxChars: 4_000_000 });
  if (shown.missing) return undefined;
  const parsed = firstJsonObject<{ status?: string; data?: { auth?: { kind?: string } } }>(shown.text);
  return parsed?.status === 'error' ? undefined : parsed?.data?.auth?.kind;
}

/** What `values` may hold for a connector, in words: the names, what each is, and the format. */
function describeDeclared(integration: string, declared: DeclaredValues): string {
  const names = Object.entries(declared).map(([name, info]) => `${name}${info.label ? ` (${info.label}${info.description ? `: ${info.description}` : ''})` : ''}`);
  return names.length ? `${integration} takes these values: ${names.join('; ')}. Each is ${VALUE_FORMAT}.` : `${integration} takes no values.`;
}

/** The first problem with the plan, in words the agent can act on; undefined when it is sound.
 * With `declared`, the connection values are checked against the connector's own list. */
export async function destinationProblem(stateDir: string, list: readonly unknown[], declared?: (integration: string) => Promise<DeclaredValues | undefined>, authKind?: (integration: string) => Promise<string | undefined>): Promise<string | undefined> {
  const all = await loadDestinations(stateDir);
  for (const [index, item] of list.entries()) {
    const at = `send_to[${index}]`;
    const d = item as Destination | null;
    if (!d || typeof d !== 'object' || typeof d.to !== 'string') return `${at} needs {to: "<destination>", with: {...}}. ${EXAMPLE}`;
    const template = all[d.to];
    if (!template) return `${at}: no destination named "${d.to}". Known: ${describeKnown(all)}. The user adds more with \`clikcode computer destination add\`. ${EXAMPLE}`;
    if (d.connectionValues !== undefined) {
      if (!takesConnectionValues(template)) return `${at}: connectionValues only goes with clikdeploy-connection or clikdeploy-connection-basic, not "${d.to}".`;
      const read = readConnectionValues(d.connectionValues);
      if (read.problem) return `${at}: ${read.problem}`;
      const refs = Object.entries(read.values ?? {}).flatMap(([name, v]) => { const m = VAULT_REF.exec(v); return m ? [[name, m[1]!] as const] : []; });
      if (refs.length) {
        const have = await namedSecretNames(stateDir).catch(() => [] as string[]);
        const lost = refs.find(([, saved]) => !have.includes(saved));
        if (lost) return `${at}: values.${lost[0]} names a saved secret "${lost[1]}" that is not in the Secrets Manager.`;
      }
    }
    if (authKind && takesConnectionValues(template) && typeof d.with?.integration === 'string' && SAFE_VALUE.test(d.with.integration)) {
      const kind = await authKind(d.with.integration).catch(quiet('agent/computer/secret-destinations'));
      if (kind && kind in ACCEPTS && !ACCEPTS[kind]!.includes(d.to)) return `${at}: ${d.to} does not fit ${d.with.integration}. ${describeShapes(d.with.integration, kind)}`;
    }
    if (declared && takesConnectionValues(template) && typeof d.with?.integration === 'string' && SAFE_VALUE.test(d.with.integration)) {
      const known = await declared(d.with.integration).catch(quiet('agent/computer/secret-destinations'));
      if (known) {
        const given = Object.keys(readConnectionValues(d.connectionValues).values ?? {});
        const unknown = given.filter(name => !(name in known));
        const missing = Object.entries(known).filter(([name, info]) => info.required !== false && !given.includes(name)).map(([name]) => name);
        if (unknown.length || missing.length) return `${at}: ${unknown.length ? `values has ${unknown.join(', ')}, which ${d.with.integration} does not take` : `${d.with.integration} needs a value for ${missing.join(', ')}`}. ${describeDeclared(d.with.integration, known)} Example: {"to":"${d.to}","with":{"integration":"${d.with.integration}"},"values":{${Object.keys(known).map(name => `"${name}":"..."`).join(',')}}}`;
      }
    }
    const saved = template.vaultSlots?.length ? await namedSecretNames(stateDir).catch(() => [] as string[]) : [];
    for (const slot of slotsOf(template)) {
      const value = d.with?.[slot];
      const ref = typeof value === 'string' && template.vaultSlots?.includes(slot) ? VAULT_REF.exec(value) : null;
      if (ref) {
        if (!saved.includes(ref[1]!)) return `${at}: with.${slot} names a saved secret "${ref[1]}" that is not in the Secrets Manager.`;
        continue;
      }
      if (template.optionalSlots?.includes(slot) && (value === undefined || value === '')) continue;
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
  const start = text.indexOf('{');
  if (start >= 0) {
    try {
      const parsed = JSON.parse(text.slice(start)) as { message?: string; error?: string | { message?: string; code?: string }; data?: { message?: string; error?: string | { message?: string }; appliedToWebProcess?: boolean; reloadReason?: string } };
      const failure = typeof parsed.error === 'object' ? parsed.error.message ?? parsed.error.code : parsed.error;
      const inner = typeof parsed.data?.error === 'object' ? parsed.data.error.message : parsed.data?.error;
      const line = [parsed.message ?? failure ?? parsed.data?.message ?? inner, parsed.data?.appliedToWebProcess !== undefined ? `appliedToWebProcess=${parsed.data.appliedToWebProcess}` : '', parsed.data?.reloadReason].filter(Boolean).join(' · ');
      return line; // valid JSON that says nothing: nothing, not the last lines of the object (`} } }`)
    } catch { /* not JSON: use the last lines */ }
  }
  return text.trim().split('\n').slice(-3).join(' ').slice(0, 300);
};

/** The first JSON object in a command's output, whatever the command printed around it (a warning before it, a hint after it). */
export function firstJsonObject<T>(text: string): T | undefined {
  for (let at = text.indexOf('{'); at >= 0; at = text.indexOf('{', at + 1)) {
    if (at > 0 && text[at - 1] !== '\n') continue; // a real object starts a line; braces inside a sentence do not
    try { const value = JSON.parse(text.slice(at)) as unknown; if (value && typeof value === 'object') return value as T; } catch { /* try the next line start */ }
    // Output followed by more text: take up to the last closing brace.
    const end = text.lastIndexOf('}');
    if (end > at) { try { const value = JSON.parse(text.slice(at, end + 1)) as unknown; if (value && typeof value === 'object') return value as T; } catch { /* keep looking */ } }
  }
  return undefined;
}

type Shown = { status?: string; message?: string; data?: { connection?: { status?: string } | null; accounts?: { status?: string }[] } };
/** Whether ClikDeploy now holds an active connection for the connector: asked of ClikDeploy, not read from the connect command's output. */
export async function connectionState(integration: string, signal?: AbortSignal): Promise<{ connected: boolean; reason?: string }> {
  const shown = await runCli('clikdeploy', ['integrations', 'show', integration], { signal, timeoutMs: 60_000, maxChars: 4_000_000 });
  if (shown.missing) return { connected: false, reason: 'the clikdeploy command is not installed on this computer' };
  const parsed = firstJsonObject<Shown>(shown.text);
  if (!parsed) return { connected: false, reason: `could not read the connection back (${say(shown.text) || 'no answer'})` };
  if (parsed.status === 'error') return { connected: false, reason: `could not read the connection back (${(parsed.message ?? 'error').split('\n')[0]})` };
  const statuses = [parsed.data?.connection?.status, ...(parsed.data?.accounts ?? []).map(account => account.status)].filter(Boolean);
  if (statuses.includes('active')) return { connected: true };
  return { connected: false, reason: statuses.length ? `${integration} shows a connection with status "${statuses[0]}", not active` : `ClikDeploy shows no connection for ${integration}` };
}

/** Wait before the one retry of an empty reply (tests set it to 0). */
let retryDelayMs = 1_500;
export function setSendRetryDelay(ms: number): void { retryDelayMs = ms; }

const JSON_FAILURE = /Unexpected end of JSON input|Unexpected token[^\n]*JSON|is not valid JSON|JSON\.parse|non-JSON/i;
/** The connect call gave back nothing usable: no words at all with a failing exit, a JSON parse failure, or a bad-gateway family status. */
function emptyReply(result: { code: number | null; text: string }): boolean {
  const text = result.text.trim();
  if (!text) return result.code !== 0;
  if (result.code === 0 && !JSON_FAILURE.test(text)) return false;
  return JSON_FAILURE.test(text) || /\b(?:HTTP\s*)?50[0-4]\b|bad gateway|service unavailable|gateway time-?out/i.test(text) && !/"status"\s*:\s*"error"/.test(text);
}
function describeEmptyReply(result: { code: number | null; text: string }): string {
  const text = result.text.replace(/\s+/g, ' ').trim();
  const status = /\b(?:HTTP\s*)?([45]\d\d)\b/.exec(text)?.[1];
  return `ClikDeploy's connect call returned an empty or non-JSON reply (${status ? `HTTP ${status}` : 'HTTP status not shown by the command'}, exit ${result.code ?? 'none'}${text ? `, it said: "${text.slice(0, 160)}"` : ', it printed nothing'})`;
}

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
    // Base-URL values (Algolia's app_id) ride in the same JSON as the key, under the name ClikDeploy's connect route reads.
    let stdin = template.stdin !== undefined ? fill(template.stdin, params, value) : undefined;
    const extra = takesConnectionValues(template) ? readConnectionValues(d.connectionValues) : {};
    if (extra.problem) { out.push({ label, ok: false, message: `NOT connected: ${extra.problem}` }); continue; }
    // A value given as secret:<name> is read from the vault now, so the agent never has to see it.
    if (extra.values) {
      let bad: string | undefined;
      for (const [name, v] of Object.entries(extra.values)) {
        const ref = VAULT_REF.exec(v);
        if (!ref) continue;
        const stored = (await readNamedSecret(stateDir, ref[1]!).catch(() => '')).trim();
        if (!VALUE_TEXT.test(stored)) { bad = `The saved secret "${ref[1]}" is missing or is not a plain value, so ${name} could not be filled (${VALUE_FORMAT}).`; break; }
        extra.values[name] = stored;
      }
      if (bad) { out.push({ label, ok: false, message: `NOT connected: ${bad}` }); continue; }
    }
    // The connect request is one JSON object, wherever the template keeps it: on stdin (`--args-json -`) or inline in the flag.
    // The connection values join it as `baseUrlVariables`, the name the connect tool reads; it is then sent on stdin when the
    // installed CLI reads it there (the key stays out of the command line) and inline only for a CLI too old for that.
    const dash = args.indexOf('--args-json');
    if (template.verify === 'connection' && dash >= 0 && args[dash + 1] !== undefined) {
      const inStdin = args[dash + 1] === '-';
      const text = inStdin ? stdin ?? '' : args[dash + 1]!;
      let body: Record<string, unknown>;
      try { body = JSON.parse(text) as Record<string, unknown>; } catch { out.push({ label, ok: false, message: `NOT connected: the destination "${d.to}" has no JSON in its --args-json (saved destinations: \`clikcode computer destination list\`).` }); continue; }
      if (extra.values && Object.keys(extra.values).length) body = { ...body, baseUrlVariables: extra.values };
      const json = JSON.stringify(body);
      if (await cliReadsArgsJsonFromStdin(program!, signal)) { args[dash + 1] = '-'; stdin = json; } else { args[dash + 1] = json; stdin = undefined; }
    } else if (stdin !== undefined && extra.values && Object.keys(extra.values).length) {
      out.push({ label, ok: false, message: `NOT connected: the destination "${d.to}" has no --args-json to carry the values.` }); continue;
    }
    if (stdin === '') stdin = undefined;
    // Any other template: \`--args-json -\` is read from stdin on clikdeploy 1.0.35 and later; for an older CLI the JSON goes inline.
    if (stdin !== undefined && dash >= 0 && args[dash + 1] === '-' && !(await cliReadsArgsJsonFromStdin(program!, signal))) { args[dash + 1] = stdin; stdin = undefined; }
    let result = await runCli(program!, args, { ...(stdin !== undefined ? { stdin } : {}), signal, timeoutMs: 90_000 });
    // An empty or non-JSON reply (a 502 while the proxy restarts) is retried once; the CLI cannot say more than its own words.
    if (!result.missing && template.verify === 'connection' && emptyReply(result)) {
      await new Promise(resolve => setTimeout(resolve, retryDelayMs));
      result = await runCli(program!, args, { ...(stdin !== undefined ? { stdin } : {}), signal, timeoutMs: 90_000 });
    }
    if (result.missing) { out.push({ label, ok: false, message: `The ${program} command is not installed on this computer.` }); continue; }
    if (template.verify === 'connection' && params.integration) {
      // One line, whatever the command printed: `connected` only when ClikDeploy itself lists an active connection.
      const said = scrubSecrets(say(result.text)).replace(/\s+/g, ' ').slice(0, 160);
      const state = await connectionState(params.integration, signal);
      if (emptyReply(result)) {
        // The reply was empty or not JSON: what happened is asked of ClikDeploy, and the status and a short excerpt are shown.
        if (state.connected) { out.push({ label, ok: true, message: 'connected (the connect call\'s reply was empty or not JSON, but ClikDeploy lists an active connection)' }); continue; }
        out.push({ label, ok: false, message: `NOT connected: ${scrubSecrets(describeEmptyReply(result))}${state.reason ? `; ${state.reason}` : ''}. The key is still saved; send it again with send_secret.` });
        continue;
      }
      const failed = result.code !== 0 || /"status"\s*:\s*"error"/.test(result.text) || /"success"\s*:\s*false/.test(result.text);
      if (failed && /Provide \{/.test(result.text)) {
        const kind = await declaredAuthKind(params.integration, signal).catch(quiet('agent/computer/secret-destinations'));
        out.push({ label, ok: false, message: `NOT connected: ${d.to} sent the wrong shape. ${kind ? describeShapes(params.integration, kind) : `Basic auth takes username and password: use clikdeploy-connection-basic (key = password) or clikdeploy-connection-basic-key (key = username).`}` });
        continue;
      }
      const reason = failed ? said || `the connect command failed (exit ${result.code})` : state.reason ? `${state.reason}${said ? `; the command said: ${said}` : ''}` : '';
      out.push(state.connected && !failed ? { label, ok: true, message: 'connected' } : { label, ok: false, message: `NOT connected: ${scrubSecrets(reason || 'no active connection found after connecting')}` });
      continue;
    }
    const ok = result.code === 0;
    // Never an empty tail: a delivery always says something a person can act on.
    out.push({ label, ok, message: scrubSecrets(say(result.text)).trim() || (ok ? 'delivered (the command succeeded and printed nothing)' : `failed (exit ${result.code ?? 'none'}, the command printed nothing)`) });
  }
  return out.map(delivery => delivery.message.trim() ? delivery : { ...delivery, message: delivery.ok ? 'delivered' : 'NOT delivered: no reason was given' });
}
