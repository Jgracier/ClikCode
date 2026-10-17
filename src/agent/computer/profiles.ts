/** Autofill profiles: the name, address and phone a person types into every signup form, kept once so an
 * agent fills a form without asking again. Personal data, not secrets: passwords, codes and card numbers
 * never go in one. Several profiles can exist (personal, company); the user picks one when more than one fits. */
import { randomUUID } from 'node:crypto';
import { readVaultRecords, removeVaultRecord, writeVaultRecord } from './credential-vault.js';

export const PROFILE_KEYS = ['given_name', 'family_name', 'email', 'phone', 'address_line1', 'address_line2', 'city', 'state', 'postal_code', 'country', 'organization', 'job_title', 'website', 'birthday'] as const;
export type ProfileKey = typeof PROFILE_KEYS[number];
export type Profile = { label: string; fields: Partial<Record<ProfileKey, string>> };
export type SavedProfile = Profile & { id: string };

const FOLDER = 'profile';

export async function listProfiles(stateDir: string): Promise<SavedProfile[]> {
  return (await readVaultRecords<Profile>(stateDir, FOLDER)).map(({ id, value }) => ({ id, label: value.label, fields: value.fields })).sort((a, b) => a.label.localeCompare(b.label));
}

/** Creates the profile, or (with an id, or a label that exists) merges these fields into it. */
export async function saveProfile(stateDir: string, input: { id?: string; label?: string; fields: Partial<Record<string, string>> }): Promise<SavedProfile> {
  const fields: Partial<Record<ProfileKey, string>> = {};
  for (const [key, value] of Object.entries(input.fields)) {
    if (!(PROFILE_KEYS as readonly string[]).includes(key)) throw new Error(`Unknown profile field "${key}". Fields: ${PROFILE_KEYS.join(', ')}.`);
    if (typeof value === 'string' && value.trim()) fields[key as ProfileKey] = (key === 'phone' ? normalizePhone(value) : value.trim()).slice(0, 200);
  }
  const all = await listProfiles(stateDir);
  const existing = all.find(profile => profile.id === input.id) ?? (input.label ? all.find(profile => profile.label.toLowerCase() === input.label!.toLowerCase()) : undefined);
  const saved: SavedProfile = existing
    ? { ...existing, label: input.id ? input.label?.trim() || existing.label : existing.label, fields: { ...existing.fields, ...fields } }
    : { id: randomUUID(), label: input.label?.trim() || 'Personal', fields };
  await writeVaultRecord(stateDir, FOLDER, saved.id, { label: saved.label, fields: saved.fields });
  return saved;
}

export async function removeProfile(stateDir: string, id: string): Promise<boolean> { return removeVaultRecord(stateDir, FOLDER, id); }

export function describeProfile(profile: SavedProfile): string {
  return `${profile.label}: ${PROFILE_KEYS.filter(key => profile.fields[key]).map(key => `${key}=${profile.fields[key]}`).join(', ') || '(empty)'}`;
}

/** What a form field asks for: its autocomplete token first, then its words. */
export type FieldHint = { autocomplete: string; type: string; text: string };

const TOKENS: Record<string, ProfileKey> = {
  'given-name': 'given_name', 'family-name': 'family_name', email: 'email', tel: 'phone', 'tel-national': 'phone', 'street-address': 'address_line1',
  'address-line1': 'address_line1', 'address-line2': 'address_line2', 'address-level2': 'city', 'address-level1': 'state', 'postal-code': 'postal_code',
  country: 'country', 'country-name': 'country', organization: 'organization', 'organization-title': 'job_title', url: 'website', bday: 'birthday',
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
  [/birth|\bdob\b/, 'birthday'],
];

/** The profile field a form field wants, if any. A password, code or card field is never one. */
export function profileKeyFor(hint: FieldHint): ProfileKey | undefined {
  if (hint.type === 'password' || /password|passcode|one-time|verification|security.?code|\botp\b|card|cvv|cvc/.test(`${hint.autocomplete} ${hint.text}`.toLowerCase())) return undefined;
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
