import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { lockCredentialVault } from './credential-vault.js';
import { isUnfillable, bestProfileFor, defaultProfile, birthdayFor, customFieldFor, describeProfile, listProfiles, normalizePhone, phoneFor, profileEmail, profileKeyFor, readProfileSecret, removeProfile, saveProfile, saveProfileSecret, secretFieldFor } from './profiles.js';
import { namedSecretNames } from './credential-vault.js';

type ProfileKeyName = NonNullable<ReturnType<typeof profileKeyFor>>;
let stateDir = '';
afterEach(async () => { if (stateDir) { lockCredentialVault(stateDir); await rm(stateDir, { recursive: true, force: true }); stateDir = ''; } });

describe('profileKeyFor', () => {
  it('uses the autocomplete token first, then the words, and never offers a password, code or card', () => {
    expect(profileKeyFor({ autocomplete: 'given-name', type: 'text', text: 'Name' })).toBe('given_name');
    expect(profileKeyFor({ autocomplete: '', type: 'text', text: 'Last Name lastName' })).toBe('family_name');
    expect(profileKeyFor({ autocomplete: '', type: 'text', text: 'Zip/Postal Code' })).toBe('postal_code');
    expect(profileKeyFor({ autocomplete: '', type: 'text', text: 'Address Line 2' })).toBe('address_line2');
    expect(profileKeyFor({ autocomplete: '', type: 'text', text: 'Address Line 1' })).toBe('address_line1');
    expect(profileKeyFor({ autocomplete: '', type: 'tel', text: 'Mobile' })).toBe('phone');
    expect(profileKeyFor({ autocomplete: 'one-time-code', type: 'text', text: 'Verification code' })).toBeUndefined();
    expect(profileKeyFor({ autocomplete: 'cc-number', type: 'text', text: 'Card number' })).toBeUndefined();
    expect(profileKeyFor({ autocomplete: 'new-password', type: 'password', text: 'Password' })).toBeUndefined();
    expect(profileKeyFor({ autocomplete: '', type: 'text', text: 'Favourite colour' })).toBeUndefined();
  });
});

describe('profileKeyFor: the business page of a sign-up', () => {
  const field = (label: string, name = '', type = 'text') => ({ autocomplete: '', type, label, text: `${label} ${name}` });
  it('maps each business box to its own detail and never the email', () => {
    expect(profileKeyFor(field('Business name', 'account[business_name]'))).toBe('organization');
    expect(profileKeyFor(field('Company name'))).toBe('organization');
    expect(profileKeyFor(field('Organization'))).toBe('organization');
    expect(profileKeyFor(field('Business phone', 'account[phone]'))).toBe('phone');
    expect(profileKeyFor(field('Work phone', 'work_phone', 'tel'))).toBe('phone');
    expect(profileKeyFor(field('Postal code', 'billing_address_postal_code'))).toBe('postal_code');
    expect(profileKeyFor(field('Zip', 'address[zip]'))).toBe('postal_code');
    expect(profileKeyFor(field('Postcode'))).toBe('postal_code');
    expect(profileKeyFor(field('Country'))).toBe('country');
    expect(profileKeyFor(field('State / Province'))).toBe('state');
    expect(profileKeyFor(field('City'))).toBe('city');
    expect(profileKeyFor(field('Email', 'user[email]', 'email'))).toBe('email');
    expect(profileKeyFor(field('Correo electrónico'))).toBe('email');
  });

  it('a registration, VAT, tax or company number has no profile detail', () => {
    for (const label of ['Registration number', 'VAT number', 'Tax ID', 'Company number', 'Business registration no.', 'Número de registro', 'Steuernummer']) {
      expect(profileKeyFor(field(label, 'account[registration_number]'))).toBeUndefined();
      expect(isUnfillable(field(label))).toBe(true);
    }
    expect(isUnfillable(field('Business name'))).toBe(false);
    expect(isUnfillable(field('Business phone number'))).toBe(false);
  });

  it('a postal code is a place, a verification code is not filled', () => {
    expect(profileKeyFor(field('Postal code'))).toBe('postal_code');
    expect(profileKeyFor(field('Verification code'))).toBeUndefined();
    expect(profileKeyFor(field('Security PIN'))).toBeUndefined();
    expect(profileKeyFor({ autocomplete: '', type: 'text', text: 'Code OTP' })).toBeUndefined();
  });

  it('knows Spanish, Portuguese, French, German and Italian labels', () => {
    const cases: [string, ProfileKeyName][] = [
      ['Nombre', 'given_name'], ['Apellidos', 'family_name'], ['Teléfono', 'phone'], ['Empresa', 'organization'], ['Nombre de la empresa', 'organization'], ['Código postal', 'postal_code'], ['Ciudad', 'city'], ['País', 'country'], ['Dirección', 'address_line1'], ['Correo electrónico', 'email'],
      ['Nome', 'given_name'], ['Sobrenome', 'family_name'], ['Telefone', 'phone'], ['Nome da empresa', 'organization'], ['CEP', 'postal_code'], ['Cidade', 'city'], ['Estado', 'state'], ['Endereço', 'address_line1'], ['E-mail', 'email'],
      ['Prénom', 'given_name'], ['Nom de famille', 'family_name'], ['Téléphone', 'phone'], ['Entreprise', 'organization'], ['Société', 'organization'], ['Code postal', 'postal_code'], ['Ville', 'city'], ['Pays', 'country'], ['Adresse', 'address_line1'], ['Courriel', 'email'],
      ['Vorname', 'given_name'], ['Nachname', 'family_name'], ['Telefonnummer', 'phone'], ['Unternehmen', 'organization'], ['Firma', 'organization'], ['Postleitzahl', 'postal_code'], ['PLZ', 'postal_code'], ['Stadt', 'city'], ['Bundesland', 'state'], ['Land', 'country'], ['Straße', 'address_line1'], ['E-Mail-Adresse', 'email'],
      ['Cognome', 'family_name'], ['Telefono', 'phone'], ['Azienda', 'organization'], ['Ragione sociale', 'organization'], ['Codice postale', 'postal_code'], ['Città', 'city'], ['Paese', 'country'], ['Indirizzo', 'address_line1'], ['Indirizzo email', 'email'],
    ];
    for (const [label, key] of cases) expect([label, profileKeyFor(field(label))]).toEqual([label, key]);
  });

  it('never offers a password or code in another language', () => {
    for (const label of ['Contraseña', 'Confirmar contraseña', 'Senha', 'Mot de passe', 'Passwort', 'Código de verificación']) expect([label, profileKeyFor(field(label))]).toEqual([label, undefined]);
  });
});

describe('phone', () => {
  it('is kept as +1 and ten digits and laid out the way the field shows it', () => {
    expect(normalizePhone('(719) 555-0123')).toBe('+17195550123');
    expect(normalizePhone('1-719-555-0123')).toBe('+17195550123');
    expect(phoneFor('+17195550123', '(702) 123-4567')).toBe('(719) 555-0123');
    expect(phoneFor('+17195550123', '702-123-4567')).toBe('719-555-0123');
    expect(phoneFor('+17195550123', '', '+1')).toBe('+17195550123');
    expect(phoneFor('+17195550123', '1234567890')).toBe('7195550123');
  });
});

describe('profiles', () => {
  it('are kept encrypted, merged by label, corrected in place, and removed', async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'clikcode-profiles-'));
    const first = await saveProfile(stateDir, { label: 'Personal', fields: { given_name: 'Ada', phone: '(719) 555-0123' } });
    await saveProfile(stateDir, { label: 'personal', fields: { city: 'Calhan', state: ' ' } });
    await saveProfile(stateDir, { label: 'Company', fields: { organization: 'Lovelace Ltd' } });
    const all = await listProfiles(stateDir);
    expect(all.map(profile => profile.label)).toEqual(['Company', 'Personal']);
    expect(all.find(profile => profile.id === first.id)!.fields).toEqual({ given_name: 'Ada', phone: '+17195550123', city: 'Calhan' });
    await saveProfile(stateDir, { id: first.id, fields: { phone: '719 555 9999' } });
    expect((await listProfiles(stateDir)).find(profile => profile.id === first.id)!.fields.phone).toBe('+17195559999');
    await expect(saveProfile(stateDir, { fields: { password: 'x' } })).rejects.toThrow('Unknown profile field');
    expect(await removeProfile(stateDir, first.id)).toBe(true);
    expect((await listProfiles(stateDir)).map(profile => profile.label)).toEqual(['Company']);
  });
});

describe('custom details an agent asked for', () => {
  const hint = (text: string, type = 'text') => ({ autocomplete: '', type, text });

  it('are kept beside the standard fields, merged by key, and removed by an empty value', async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'clikcode-profiles-'));
    const saved = await saveProfile(stateDir, { label: 'ClikDeploy apps', fields: { organization: 'ClikDeploy' }, custom: {
      app_name: { label: 'App name', value: ' ClikDeploy ', match: ['App Name', 'application name', 'x'] },
      privacy_policy_url: { label: 'Privacy policy', value: 'https://clikdeploy.com/legal/privacy' },
    } });
    expect(saved.custom).toEqual({
      app_name: { label: 'App name', value: 'ClikDeploy', match: ['app name', 'application name'] },
      privacy_policy_url: { label: 'Privacy policy', value: 'https://clikdeploy.com/legal/privacy' },
    });
    // A later value keeps the label and words; an empty one removes the field.
    const again = await saveProfile(stateDir, { id: saved.id, fields: {}, custom: { app_name: { value: 'ClikDeploy Gateway' }, privacy_policy_url: { value: '' } } });
    expect(again.custom).toEqual({ app_name: { label: 'App name', value: 'ClikDeploy Gateway', match: ['app name', 'application name'] } });
    expect((await listProfiles(stateDir))[0]!.custom).toEqual(again.custom);
    expect(describeProfile(again)).toContain('app_name=ClikDeploy Gateway');
  });

  it('refuse a secret, a standard name, a bad name and too much', async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'clikcode-profiles-'));
    await expect(saveProfile(stateDir, { fields: {}, custom: { client_secret: { value: 'Zq8xW3vLm9PaRt5YcN2bKd7HgF4jS6eU' } } })).rejects.toThrow('looks like a key');
    await expect(saveProfile(stateDir, { fields: {}, custom: { email: { value: 'a@b.co' } } })).rejects.toThrow('standard profile field');
    await expect(saveProfile(stateDir, { fields: {}, custom: { 'App Name': { value: 'x' } } })).rejects.toThrow('lower-case');
    await expect(saveProfile(stateDir, { fields: {}, custom: { app_description: { value: 'x'.repeat(2001) } } })).rejects.toThrow('longer than');
    // A description with a URL and an email in it is not a secret.
    const ok = await saveProfile(stateDir, { fields: {}, custom: { support: { value: 'Write to support@clikdeploy.com or see https://clikdeploy.com/support' } } });
    expect(ok.custom?.support?.value).toContain('support@clikdeploy.com');
  });

  it('match a form field by the words the agent gave, the most specific first, and never a password, code or card', async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'clikcode-profiles-'));
    const profile = await saveProfile(stateDir, { fields: { email: 'ada@example.com' }, custom: {
      app_name: { label: 'App name', value: 'ClikDeploy', match: ['app name', 'application name'] },
      support_email: { label: 'Support email', value: 'support@clikdeploy.com', match: ['support email'] },
      homepage: { label: 'Homepage URL', value: 'https://clikdeploy.com' },
    } });
    expect(customFieldFor(profile, hint('Application name *'))?.field.value).toBe('ClikDeploy');
    expect(customFieldFor(profile, hint('Support email address'))?.key).toBe('support_email');
    // Its label and name stand in when no words were given.
    expect(customFieldFor(profile, hint('Homepage URL'))?.key).toBe('homepage');
    // A form's plain "Email" is the standard field's, not the support email's.
    expect(customFieldFor(profile, hint('Email'))).toBeUndefined();
    expect(customFieldFor(profile, hint('Favourite colour'))).toBeUndefined();
    expect(customFieldFor(profile, hint('App name verification code'))).toBeUndefined();
    expect(customFieldFor(profile, hint('App name', 'password'))).toBeUndefined();
    expect(customFieldFor({ }, hint('App name'))).toBeUndefined();
  });
});

it('merges into the only profile when neither an id nor a label is given', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'clikcode-profile-one-'));
  try {
    const first = await saveProfile(stateDir, { label: 'Home', fields: { given_name: 'Ada' } });
    await saveProfile(stateDir, { fields: { sso_email: 'ada@example.com' } });
    const all = await listProfiles(stateDir);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ id: first.id, fields: { given_name: 'Ada', sso_email: 'ada@example.com' } });
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});

it('splits a saved birth date into the part a form field asks for', () => {
  expect(birthdayFor('06/18/1998', 'Birth year')).toBe('1998');
  expect(birthdayFor('06/18/1998', 'yyyy')).toBe('1998');
  expect(birthdayFor('06/08/1998', 'Day')).toBe('08');
  expect(birthdayFor('06/18/1998', 'dd')).toBe('18');
  expect(birthdayFor('06/18/1998', 'Month')).toBe('June');
  expect(birthdayFor('06/18/1998', 'mm')).toBe('06');
  expect(birthdayFor('06/18/1998', 'Date of birth mm/dd/yyyy')).toBe('06/18/1998');
  expect(birthdayFor('06/18/1998', 'Date of birth dd/mm/yyyy')).toBe('18/06/1998');
  expect(birthdayFor('1998', 'Birth year')).toBe('1998');
});

it('recognises the day, month and year boxes of a split date of birth by their placeholders', () => {
  for (const text of ['dd', 'yyyy', 'mm', 'Birth year', 'Date of birth', 'bday']) expect(profileKeyFor({ autocomplete: '', type: 'text', text }), text).toBe('birthday');
  expect(profileKeyFor({ autocomplete: 'bday-year', type: 'text', text: 'Year' })).toBe('birthday');
});

describe('profile secrets', () => {
  it('keeps the value out of the profile, fills the password box and a matching box, and goes with the profile', async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'profile-secret-'));
    const profile = await saveProfile(stateDir, { label: 'Personal', fields: { given_name: 'Ada' } });
    await saveProfileSecret(stateDir, profile.id, 'password', 'Zx9!correct-horse');
    await saveProfileSecret(stateDir, profile.id, 'recovery_code', 'RC-12345-67890', { match: ['recovery code'] });
    const [saved] = await listProfiles(stateDir);
    expect(JSON.stringify(saved)).not.toContain('correct-horse');
    expect(JSON.stringify(saved)).not.toContain('RC-12345');
    expect(describeProfile(saved!)).toContain('password=(secret, hidden)');
    expect(describeProfile(saved!)).not.toContain('correct-horse');
    expect(await readProfileSecret(stateDir, saved!, 'password')).toBe('Zx9!correct-horse');
    expect(secretFieldFor(saved, { autocomplete: 'new-password', type: 'password', text: 'Password' })).toBe('password');
    expect(secretFieldFor(saved, { autocomplete: 'one-time-code', type: 'password', text: 'Verification code' })).toBeUndefined();
    expect(secretFieldFor(saved, { autocomplete: '', type: 'text', text: 'Enter your recovery code' })).toBe('recovery_code');
    expect(secretFieldFor(saved, { autocomplete: '', type: 'text', text: 'First name' })).toBeUndefined();
    await saveProfile(stateDir, { id: profile.id, fields: { city: 'Denver' } });
    expect(Object.keys((await listProfiles(stateDir))[0]!.secrets ?? {})).toEqual(['password', 'recovery_code']);
    await removeProfile(stateDir, profile.id);
    expect(await namedSecretNames(stateDir)).toEqual([]);
  });
});


describe('bestProfileFor: several profiles never mean asking', () => {
  const personal = { id: 'p', label: 'Personal', fields: { given_name: 'J', email: 'gracierdigital@gmail.com', phone: '1', address_line1: 'x' }, custom: {} } as never;
  const admin = { id: 'a', label: 'ClikDeploy admin', fields: { given_name: 'J', email: 'admin@x.test' }, custom: {} } as never;
  const railway = { id: 'r', label: 'Railway', fields: { given_name: 'J', organization: 'R' }, custom: { railway_email: { label: 'Railway email', value: 'justin@webpro.ai', match: ['email'] } } } as never;
  const hint = (text: string) => ({ text, type: 'text', autocomplete: '' });

  it('uses the default profile (Personal) whatever the form asks for', () => {
    expect(bestProfileFor([admin, personal], [hint('email')])?.label).toBe('Personal');
    expect(bestProfileFor([admin, personal], [hint('phone'), hint('street address')])?.label).toBe('Personal');
    expect(bestProfileFor([personal, admin], [])?.label).toBe('Personal');
  });

  it('two profiles with different emails: an Email field gets the default profile\'s, even when the other profile holds a custom "email" detail', () => {
    const picked = bestProfileFor([railway, personal], [hint('Email')], undefined, 'example-signup.test');
    expect(picked?.label).toBe('Personal');
    expect(picked?.fields.email).toBe('gracierdigital@gmail.com');
    expect(customFieldFor(picked as never, hint('Email'))).toBeUndefined();
  });

  it('another profile is used only on the site it declares (by its label or its website)', () => {
    expect(bestProfileFor([railway, personal], [hint('Email')], undefined, 'railway.com')?.label).toBe('Railway');
    expect(bestProfileFor([railway, personal], [hint('Email')], undefined, 'login.railway.app')?.label).toBe('Railway');
    expect(bestProfileFor([admin, personal], [hint('Email')], undefined, 'admin.example.com')?.label).toBe('Personal');
    const site = { id: 's', label: 'Hosting', fields: { website: 'https://www.hoster.test/x' }, custom: {} } as never;
    expect(bestProfileFor([site, personal], [], undefined, 'app.hoster.test')?.label).toBe('Hosting');
  });

  it('real profile shapes (AWS, ClikDeploy admin, Personal, Railway): cliengo.com gets Personal; each declared site its own', () => {
    const aws = { id: 'w', label: 'AWS', fields: { email: 'aws@x.test' }, custom: {} } as never;
    const all = [aws, admin, personal, railway];
    for (const host of ['cliengo.com', 'app.cliengo.com', 'www.cliengo.com.ar', 'us.cliengo.io']) expect(bestProfileFor(all, [hint('Email')], undefined, host)?.label).toBe('Personal');
    expect(bestProfileFor(all, [], undefined, 'console.aws.amazon.com')?.label).toBe('AWS');
    expect(bestProfileFor(all, [], undefined, 'railway.com')?.label).toBe('Railway');
    const listed = { id: 'l', label: 'Other', fields: {}, custom: { sites: { label: 'sites', value: 'cliengo.com, foo.test' } } } as never;
    expect(bestProfileFor([listed, personal], [], undefined, 'app.cliengo.com')?.label).toBe('Other');
  });

  it('an explicit label wins, and a single profile is just that profile', () => {
    expect(bestProfileFor([admin, personal], [hint('email')], 'clikdeploy admin')?.label).toBe('ClikDeploy admin');
    expect(bestProfileFor([admin], [hint('email')])?.label).toBe('ClikDeploy admin');
    expect(bestProfileFor([], [hint('email')])).toBeUndefined();
  });
});

describe('defaultProfile: no label never means a second profile', () => {
  const mk = (label: string, fields: Record<string, string>) => ({ id: label, label, fields }) as never;
  it('is Personal, else the profile with the most standard fields', () => {
    const admin = mk('ClikDeploy admin', { email: 'admin@x.test', given_name: 'A', family_name: 'B', phone: '1' });
    expect(defaultProfile([admin, mk('Personal', { email: 'me@x.test' })])?.label).toBe('Personal');
    expect(defaultProfile([admin, mk('Zed', { email: 'z@x.test' })])?.label).toBe('ClikDeploy admin');
    expect(defaultProfile([])).toBeUndefined();
  });

  it('saving with no label merges into Personal and never creates a duplicate or touches the other profile', async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'clikcode-profiles-'));
    await saveProfile(stateDir, { label: 'ClikDeploy admin', fields: { email: 'admin@clikdeploy.test' } });
    await saveProfile(stateDir, { label: 'Personal', fields: { email: 'me@example.test' } });
    await saveProfile(stateDir, { fields: { city: 'Calhan' } });
    const all = await listProfiles(stateDir);
    expect(all.map(profile => profile.label)).toEqual(['ClikDeploy admin', 'Personal']);
    expect(all.find(profile => profile.label === 'Personal')?.fields).toMatchObject({ email: 'me@example.test', city: 'Calhan' });
    expect(all.find(profile => profile.label === 'ClikDeploy admin')?.fields).toEqual({ email: 'admin@clikdeploy.test' });
  });
});

describe('profileEmail: one mailbox, never the first profile by label', () => {
  it('is the default profile\'s sign-in email even when another profile sorts first, and falls back to any profile that has one', async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'clikcode-profile-'));
    expect(await profileEmail(stateDir)).toBeUndefined();
    await saveProfile(stateDir, { label: 'ClikDeploy admin', fields: { sso_email: 'justin@clikdeploy.com' } });
    expect(await profileEmail(stateDir)).toBe('justin@clikdeploy.com');
    await saveProfile(stateDir, { label: 'Personal', fields: { sso_email: 'gracierdigital@gmail.com', given_name: 'Justin', family_name: 'G' } });
    expect(await profileEmail(stateDir)).toBe('gracierdigital@gmail.com');
  });
});
