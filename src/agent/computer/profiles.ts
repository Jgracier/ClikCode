/** Autofill profiles: the name, address and phone a person types into every signup form, kept once so an
 * agent fills a form without asking again. Details are shown to the agent. A profile can also hold secrets
 * (the password for sign-ups, a recovery code): only their names are in the profile record, the values live in
 * Secrets Manager, and nothing returns one to the agent; a form field is filled from it without being shown it.
 * Several profiles can exist (personal, company); the user picks one when more than one fits. */
import { quiet } from '../../runtime/lifecycle-log.js';
import { randomUUID } from 'node:crypto';
import { deleteNamedSecret, readNamedSecret, readVaultRecords, removeVaultRecord, saveNamedSecret, writeVaultRecord } from './credential-vault.js';
import { keyShaped } from './secret-finder.js';

export const PROFILE_KEYS = ['given_name', 'family_name', 'email', 'phone', 'address_line1', 'address_line2', 'city', 'state', 'postal_code', 'country', 'organization', 'job_title', 'website', 'birthday', 'sso_email'] as const;
export type ProfileKey = typeof PROFILE_KEYS[number];
/** A field an agent asked the user for beyond the standard ones: an OAuth app's name and description, its
 * privacy-policy address, a company's legal name. `match` is the words a form's label may use for it. */
export type CustomField = { label: string; value: string; match?: string[] };
/** A secret kept with a profile: its name and the words a form may label it with. The value is never here. */
export type SecretField = { label: string; match?: string[] };
/** The secret that fills any password box on a sign-up or sign-in the profile is used for. */
export const PASSWORD_SECRET = 'password';
export type Profile = { label: string; fields: Partial<Record<ProfileKey, string>>; custom?: Record<string, CustomField>; secrets?: Record<string, SecretField> };
type SavedProfile = Profile & { id: string };

const FOLDER = 'profile';

export async function listProfiles(stateDir: string): Promise<SavedProfile[]> {
  return (await readVaultRecords<Profile>(stateDir, FOLDER)).map(({ id, value }) => ({ id, label: value.label, fields: value.fields, ...(value.custom ? { custom: value.custom } : {}), ...(value.secrets ? { secrets: value.secrets } : {}) })).sort((a, b) => a.label.localeCompare(b.label));
}

/** The profile meant when no label is given: the one called Personal, else the one with the most standard fields (then by label).
 * Never "the first by name", which let a second profile such as "ClikDeploy admin" be filled in as the user. */
export function defaultProfile<P extends SavedProfile>(profiles: readonly P[]): P | undefined {
  const standard = (profile: P): number => PROFILE_KEYS.filter(key => profile.fields[key]).length;
  return [...profiles].sort((a, b) => Number(b.label.toLowerCase() === 'personal') - Number(a.label.toLowerCase() === 'personal') || standard(b) - standard(a) || a.label.localeCompare(b.label))[0];
}

/** The sign-in email every sign-up uses: the default profile's (Personal), else any other profile's. Never "the first by label",
 * which put an admin profile such as "ClikDeploy" (justin@clikdeploy.com) ahead of the user's own. */
export async function profileEmail(stateDir: string): Promise<string | undefined> {
  const listed = await listProfiles(stateDir);
  const first = defaultProfile(listed);
  return (first ? [first, ...listed.filter(profile => profile !== first)] : listed).map(profile => profile.fields.sso_email).find(Boolean);
}

/** Creates the profile, or (with an id, or a label that exists) merges these fields into it. */
export async function saveProfile(stateDir: string, input: { id?: string; label?: string; fields: Partial<Record<string, string>>; custom?: Record<string, { label?: string; value: string; match?: string[] }> }): Promise<SavedProfile> {
  const fields: Partial<Record<ProfileKey, string>> = {};
  for (const [key, value] of Object.entries(input.fields)) {
    if (!(PROFILE_KEYS as readonly string[]).includes(key)) throw new Error(`Unknown profile field "${key}". Fields: ${PROFILE_KEYS.join(', ')}.`);
    if (typeof value === 'string' && value.trim()) fields[key as ProfileKey] = (key === 'phone' ? normalizePhone(value) : value.trim()).slice(0, 200);
  }
  const all = await listProfiles(stateDir);
  // With neither an id nor a label, the default profile is the one meant (the only one, else Personal): a second "Personal" would only split the user's details in two.
  const existing = all.find(profile => profile.id === input.id) ?? (input.label ? all.find(profile => profile.label.toLowerCase() === input.label!.toLowerCase()) : !input.id ? defaultProfile(all) : undefined);
  const custom = mergeCustom(existing?.custom, input.custom);
  const saved: SavedProfile = existing
    ? { ...existing, label: input.id ? input.label?.trim() || existing.label : existing.label, fields: { ...existing.fields, ...fields }, ...(custom ? { custom } : {}) }
    : { id: randomUUID(), label: input.label?.trim() || 'Personal', fields, ...(custom ? { custom } : {}) };
  await writeVaultRecord(stateDir, FOLDER, saved.id, { label: saved.label, fields: saved.fields, ...(saved.custom ? { custom: saved.custom } : {}), ...(saved.secrets ? { secrets: saved.secrets } : {}) });
  return saved;
}

export async function removeProfile(stateDir: string, id: string): Promise<boolean> {
  const profile = (await listProfiles(stateDir)).find(item => item.id === id);
  for (const key of Object.keys(profile?.secrets ?? {})) await deleteNamedSecret(stateDir, secretName(id, key)).catch(() => false);
  return removeVaultRecord(stateDir, FOLDER, id);
}

const secretName = (id: string, key: string): string => `profile/${id.slice(0, 8)}/${key}`;

/** Keeps a secret with the profile: the value goes to Secrets Manager, the profile record only learns its name. */
export async function saveProfileSecret(stateDir: string, id: string, key: string, value: string, spec: { label?: string; match?: string[] } = {}): Promise<void> {
  assertCustomKey(key, true);
  const profile = (await listProfiles(stateDir)).find(item => item.id === id);
  if (!profile) throw new Error('No such profile.');
  if (!value) throw new Error(`The secret "${key}" is empty.`);
  await saveNamedSecret(stateDir, secretName(id, key), value);
  const label = (spec.label?.trim() || profile.secrets?.[key]?.label || key.replace(/_/g, ' ')).slice(0, 80);
  const match = spec.match ? spec.match.map(item => item.trim().toLowerCase()).filter(item => item.length >= 3 && item.length <= 60).slice(0, 8) : profile.secrets?.[key]?.match;
  if (Object.keys(profile.secrets ?? {}).length >= MAX_SECRETS && !profile.secrets?.[key]) throw new Error(`A profile holds at most ${MAX_SECRETS} secrets.`);
  const secrets = { ...profile.secrets, [key]: { label, ...(match?.length ? { match } : {}) } };
  await writeVaultRecord(stateDir, FOLDER, id, { label: profile.label, fields: profile.fields, ...(profile.custom ? { custom: profile.custom } : {}), secrets });
}

/** For filling a form box only: callers must never put the value in model-visible output. */
export async function readProfileSecret(stateDir: string, profile: { id: string; secrets?: Record<string, SecretField> }, key: string): Promise<string | undefined> {
  return profile.secrets?.[key] ? readNamedSecret(stateDir, secretName(profile.id, key)).catch(quiet('agent/computer/profiles')) : undefined;
}

const CUSTOM_KEY = /^[a-z][a-z0-9_]{0,39}$/;

/** Throws for a custom field name that cannot be kept, so a prompt is never shown for one. */
export function assertCustomKey(key: string, secret = false): void {
  if (!CUSTOM_KEY.test(key)) throw new Error(`A custom field name is lower-case letters, digits and underscores, starting with a letter (got "${key}").`);
  if (!secret && (PROFILE_KEYS as readonly string[]).includes(key)) throw new Error(`"${key}" is a standard profile field: save it with fields, not custom.`);
}
const MAX_CUSTOM_FIELDS = 40;
const MAX_SECRETS = 20;
const MAX_CUSTOM_VALUE = 2000;

/** The agent's own fields, merged into what is kept: a value replaces the one before it (its label and words stay
 * unless given again). Personal and business details, never a credential: a key-shaped word is refused, because
 * a profile is shown to the agent and typed into forms, and a secret has its own place (capture_secret). */
function mergeCustom(existing: Record<string, CustomField> | undefined, input: Record<string, { label?: string; value: string; match?: string[] }> | undefined): Record<string, CustomField> | undefined {
  if (!input || !Object.keys(input).length) return existing;
  const next: Record<string, CustomField> = { ...existing };
  for (const [key, given] of Object.entries(input)) {
    assertCustomKey(key);
    const value = typeof given.value === 'string' ? given.value.trim() : '';
    if (!value) { delete next[key]; continue; }
    if (value.length > MAX_CUSTOM_VALUE) throw new Error(`The value of "${key}" is longer than ${MAX_CUSTOM_VALUE} characters.`);
    if (value.split(/\s+/).some(keyShaped)) throw new Error(`The value of "${key}" looks like a key or token. A profile holds details, not secrets: capture it with capture_secret instead.`);
    const label = (given.label?.trim() || next[key]?.label || key.replace(/_/g, ' ')).slice(0, 80);
    const match = given.match ? given.match.map(item => item.trim().toLowerCase()).filter(item => item.length >= 3 && item.length <= 60).slice(0, 8) : next[key]?.match;
    next[key] = { label, value, ...(match?.length ? { match } : {}) };
  }
  if (Object.keys(next).length > MAX_CUSTOM_FIELDS) throw new Error(`A profile holds at most ${MAX_CUSTOM_FIELDS} custom fields.`);
  return Object.keys(next).length ? next : undefined;
}

export function describeProfile(profile: SavedProfile): string {
  const standard = PROFILE_KEYS.filter(key => profile.fields[key]).map(key => `${key}=${profile.fields[key]}`);
  const custom = Object.entries(profile.custom ?? {}).map(([key, field]) => `${key}=${field.value.length > 300 ? `${field.value.slice(0, 300)}…` : field.value}`);
  const secrets = Object.keys(profile.secrets ?? {}).map(key => `${key}=(secret, hidden)`);
  return `${profile.label}: ${[...standard, ...custom, ...secrets].join(', ') || '(empty)'}`;
}

/** What a form field asks for: its autocomplete token first, then its words. */
export type FieldHint = { autocomplete: string; type: string; text: string };

const TOKENS: Record<string, ProfileKey> = {
  'given-name': 'given_name', 'family-name': 'family_name', email: 'email', tel: 'phone', 'tel-national': 'phone', 'street-address': 'address_line1',
  'address-line1': 'address_line1', 'address-line2': 'address_line2', 'address-level2': 'city', 'address-level1': 'state', 'postal-code': 'postal_code',
  country: 'country', 'country-name': 'country', organization: 'organization', 'organization-title': 'job_title', url: 'website', bday: 'birthday', 'bday-day': 'birthday', 'bday-month': 'birthday', 'bday-year': 'birthday',
};
const WORDS: [RegExp, ProfileKey][] = [
  [/first.?name|given.?name|forename|\bfname\b/, 'given_name'],
  [/last.?name|family.?name|surname|\blname\b/, 'family_name'],
  [/e-?mail/, 'email'],
  [/phone|mobile|\btel\b|cell/, 'phone'],
  [/address.?(?:line)?.?2|apt|suite|unit|\bapartment\b/, 'address_line2'],
  [/address|street/, 'address_line1'],
  [/\bcity\b|town/, 'city'],
  [/\bstate\b|province|region(?!al)/, 'state'],
  [/zip|postal|post.?code/, 'postal_code'],
  [/country|territory/, 'country'],
  [/company|organi[sz]ation|employer|business.?name/, 'organization'],
  [/job.?title|position|\brole\b/, 'job_title'],
  [/website|\burl\b/, 'website'],
  [/birth|\bdob\b|\bbday\b|\b(?:dd|mm|yyyy)\b/, 'birthday'],
];

/** A password, code or card field: never filled from a profile. */
function isSecretField(hint: FieldHint): boolean {
  return hint.type === 'password' || /password|passcode|one-time|verification|security.?code|\botp\b|card|cvv|cvc/.test(`${hint.autocomplete} ${hint.text}`.toLowerCase());
}

const words = (text: string): string => ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;

/** The custom field of this profile a form field asks for, if any: the longest of its words (or, with none given, its
 * label and name) found whole in the form field's own words. A password, code or card field never matches. */
export function customFieldFor(profile: { custom?: Record<string, CustomField> } | undefined, hint: FieldHint): { key: string; field: CustomField } | undefined {
  if (!profile?.custom || isSecretField(hint)) return undefined;
  const asked = words(hint.text);
  let best: { key: string; field: CustomField; length: number } | undefined;
  for (const [key, field] of Object.entries(profile.custom)) {
    for (const phrase of field.match?.length ? field.match : [field.label, key.replace(/_/g, ' ')]) {
      const needle = words(phrase);
      if (needle.trim().length >= 3 && asked.includes(needle) && (!best || needle.length > best.length)) best = { key, field, length: needle.length };
    }
  }
  return best ? { key: best.key, field: best.field } : undefined;
}

/** The secret of this profile a form field asks for: the password secret for any password box, another secret by its
 * words (a "recovery code" box). Unlike details, secrets are the only thing that fills a password, code or card field. */
export function secretFieldFor(profile: { secrets?: Record<string, SecretField> } | undefined, hint: FieldHint): string | undefined {
  if (!profile?.secrets) return undefined;
  if (hint.type === 'password' && profile.secrets[PASSWORD_SECRET] && !/one-time|verification|security.?code|\botp\b|current-password/i.test(`${hint.autocomplete} ${hint.text}`)) return PASSWORD_SECRET;
  const asked = words(hint.text);
  let best: { key: string; length: number } | undefined;
  for (const [key, field] of Object.entries(profile.secrets)) {
    if (key === PASSWORD_SECRET) continue;
    for (const phrase of field.match?.length ? field.match : [field.label, key.replace(/_/g, ' ')]) {
      const needle = words(phrase);
      if (needle.trim().length >= 3 && asked.includes(needle) && (!best || needle.length > best.length)) best = { key, length: needle.length };
    }
  }
  return best?.key;
}

/** The profile field a form field wants, if any. A password, code or card field is never one. */
export function profileKeyFor(hint: FieldHint): ProfileKey | undefined {
  if (isSecretField(hint)) return undefined;
  for (const token of hint.autocomplete.toLowerCase().split(/\s+/)) if (TOKENS[token]) return TOKENS[token];
  const text = hint.text.toLowerCase();
  for (const [pattern, key] of WORDS) if (pattern.test(text)) return key;
  return hint.type === 'email' ? 'email' : hint.type === 'tel' ? 'phone' : undefined;
}

/** A US-style phone number laid out the way a field's placeholder shows it; otherwise the digits as given. */
export function phoneFor(value: string, placeholder = '', currentValue = ''): string {
  const digits = value.replace(/\D/g, '');
  const national = value.trim().startsWith('+1') || digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  // A widget that shows "+1" already, or a country picker, wants the number with its country code.
  if (currentValue.trim().startsWith('+')) return value.trim().startsWith('+') ? value.trim() : `+1${national}`;
  if (national.length === 10 && /\(/.test(placeholder)) return `(${national.slice(0, 3)}) ${national.slice(3, 6)}-${national.slice(6)}`;
  if (national.length === 10 && /\d{3}-\d{3}/.test(placeholder)) return `${national.slice(0, 3)}-${national.slice(3, 6)}-${national.slice(6)}`;
  if (national.length === 10 && /^\d{10}$/.test(placeholder.trim())) return national;
  return value.trim();
}

/** The phone as it is kept: +1 and ten digits for a US number, else a plus and the digits. */
export function normalizePhone(value: string): string {
  const digits = value.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return value.trim().startsWith('+') ? `+${digits}` : digits;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** The part of a saved birth date (MM/DD/YYYY) a form field wants, judged from its words: a year box, a day box, a month
 * box or select, or the whole date in the order the placeholder shows. */
export function birthdayFor(value: string, words = ''): string {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value.trim());
  if (!match) return value.trim();
  const [, month, day, year] = match as unknown as [string, string, string, string];
  const hint = words.toLowerCase();
  if (/\b(yyyy|year)\b/.test(hint) && !/\b(mm|dd|month|day)\b/.test(hint)) return year;
  if (/\b(dd|day)\b/.test(hint) && !/\b(mm|month|yyyy|year)\b/.test(hint)) return day;
  if (/\b(mm|month)\b/.test(hint) && !/\b(dd|day|yyyy|year)\b/.test(hint)) return /\bmm\b/.test(hint) ? month : MONTHS[Number(month) - 1] ?? month;
  const order = /\d{2}[-/. ]\d{2}[-/. ]\d{4}|dd[-/. ]mm|mm[-/. ]dd|yyyy[-/. ]mm/.exec(hint)?.[0] ?? '';
  if (/^yyyy/.test(order)) return `${year}-${month}-${day}`;
  if (/^dd/.test(order)) return `${day}/${month}/${year}`;
  return `${month}/${day}/${year}`;
}


/**
 * Which saved profile fills a form when there are several. Nobody is asked: an unattended run cannot answer, and a person who
 * keeps two profiles (a personal one, one for a bot account) meant "the one that fits this form". Score = how many of the form's
 * blank fields the profile can fill (standard or custom detail); ties go to the profile with more saved details. When a profile
 * called Personal exists it is used for every form, unless another profile holds more of the details the agent asked for by name. `label` (the call's `label` argument) wins when it names a profile.
 */
export function bestProfileFor<P extends SavedProfile>(profiles: readonly P[], hints: readonly FieldHint[], label?: string): P | undefined {
  if (profiles.length <= 1) return profiles[0];
  const named = label ? profiles.find(candidate => candidate.label.toLowerCase() === label.trim().toLowerCase()) : undefined;
  if (named) return named;
  const score = (candidate: P): number => hints.filter(hint => { const key = profileKeyFor(hint); return (key && candidate.fields[key]) || customFieldFor(candidate, hint); }).length;
  // Standard details (name, email, address) are the user's own: a form that asks for them is filled as Personal, even when another
  // profile (the admin one, "ClikDeploy") has more of them saved. Another profile wins only on a detail the agent asked for by name.
  const personalProfile = profiles.find(candidate => candidate.label.toLowerCase() === 'personal');
  if (personalProfile) {
    const askedBy = (candidate: P): number => hints.filter(hint => customFieldFor(candidate, hint)).length;
    const better = profiles.filter(candidate => candidate !== personalProfile && askedBy(candidate) > askedBy(personalProfile));
    return better.sort((a, b) => askedBy(b) - askedBy(a) || score(b) - score(a))[0] ?? personalProfile;
  }
  const size = (candidate: P): number => Object.keys(candidate.fields).length + Object.keys(candidate.custom ?? {}).length;
  return [...profiles].sort((a, b) => score(b) - score(a) || size(b) - size(a))[0];
}
