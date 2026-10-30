/** Decides whether a page with password boxes makes a new password (a sign-up, an invite, a set-your-password step) or asks for the
 * one an account already has (a sign-in). One rule for both, so the answer is the same wherever it is asked, and the reason is named. */
import type { Page } from 'playwright-core';

export type PasswordPageContext = {
  url: string;
  /** Visible password boxes on the page. */
  boxes: number;
  /** Label, placeholder, aria-label, name and id of every visible password box. */
  boxText: string;
  /** Headings, legends and the title. */
  headings: string;
  /** A "forgot password" link or button is on the page. */
  forgotLink: boolean;
  /** A visible, non-password text/email box already holds a value (an account that is known). */
  prefilledAccount: boolean;
  /** What the form around the password box shows besides it. Absent: nothing is known beyond the fields above. */
  form?: FormSignals;
};

/** The sign-up and sign-in cues of the form (the password box's own form, else the page), read from the page. */
export type FormSignals = {
  /** Label, name, id, placeholder and autocomplete of every visible non-password text box, joined with " | ". */
  fieldText: string;
  /** Visible text boxes, selects and password boxes. */
  inputs: number;
  /** A visible select or combobox (a company size, a "how will you use it" dropdown). */
  dropdown: boolean;
  /** A checkbox whose own label talks about terms, privacy or accepting. */
  termsBox: boolean;
  /** Text of the form's submit buttons. */
  submitText: string;
  /** The words next to the password box (a hint such as "Between 8 and 20 characters"). */
  hintText: string;
};

export type PasswordPageKind = { kind: 'signup' | 'signin'; reason: string };

const STRONG = /\b(?:new|create|set|choose|pick|make)\b[^.]{0,20}\bpassword\b|\bpassword\b[^.]{0,12}\b(?:new|create)\b|\bconfirm(?:ation)?\b[^.]{0,12}\bpassword\b|\bre-?(?:enter|type)\b[^.]{0,12}\bpassword\b|new-password/i;
const WEAK_TEXT = /\bwelcome(?!\s+back)\b|complete your (?:account|profile|registration)|finish (?:setting up|your (?:account|profile))|you(?:'|’)?ve been invited|accept (?:your )?invit/i;
const WEAK_PATH = /(?:^|[/_-])(?:welcome|onboarding|set-?password|setup|complete|invite|activate)(?:$|[/_-])/i;

/** Accents removed and lower case, so "Contraseña", "Regístrate" and "Créer" are matched by plain letters. */
const plain = (text: string): string => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

// English, Spanish, Portuguese, French, German, Italian.
const SIGNUP_SUBMIT = /create (?:an? |your |my )?(?:free )?account|sign ?up|register|join\b|get started|crear (?:una |mi )?cuenta|registr(?:ar|arse|ate|arme|o)\b|unete|criar (?:uma |minha )?conta|cadastr|inscrev|creer (?:un |mon )?compte|s inscrire|inscription|je m inscris|konto (?:erstellen|anlegen)|registrier|jetzt starten|crea (?:un |il tuo )?account|registrati|iscriviti|registrazione/;
const LOGIN_SUBMIT = /log ?in\b|sign ?in\b|iniciar sesion|inicia sesion|entrar|acceder|ingresar|\blogin\b|connexion|se connecter|einloggen|anmelden|accedi|accesso|\bentra\b/;
const NAME_FIELD = /(?:^|[^a-z])(?:full ?name|first ?name|last ?name|given-name|family-name|your name|name|nombres?|apellidos?|nome|sobrenome|prenom|nom|vorname|nachname|cognome)(?:$|[^a-z])/;
const PHONE_FIELD = /phone|mobile|\btel\b|telefon|telefone|telephone|movil|celular|handy|cellulare|whatsapp/;
const COMPANY_FIELD = /company|empresa|organi[sz]ation|entreprise|societe|unternehmen|azienda|business/;
const PASSWORD_RULES = /\d+\s*(?:characters?|caracteres?|zeichen|caratteri|chars?)|\b\d+\s*(?:y|a|-|to|and|e|et|und|bis)\s*\d+\b|at least|minimum|minimo|mindestens|au moins|almeno|pelo menos|one number|uppercase|mayuscula|maiuscol|majuscule|grossbuchstabe|un numero|special character|simbolo/;

/** Sign-up cues of a form other than an email that is filled in. Empty when it shows none. */
export function signUpCues(form: FormSignals | undefined): string[] {
  if (!form) return [];
  const fields = plain(form.fieldText).replace(/username|user name|nombre de usuario/g, '');
  const cues: string[] = [];
  if (NAME_FIELD.test(fields)) cues.push('a name field');
  if (PHONE_FIELD.test(fields)) cues.push('a phone field');
  if (form.dropdown || COMPANY_FIELD.test(fields)) cues.push('a company or dropdown field');
  if (form.termsBox) cues.push('a terms/privacy checkbox');
  if (SIGNUP_SUBMIT.test(plain(form.submitText).replace(/[^a-z0-9]+/g, ' '))) cues.push('a create-account button');
  if (PASSWORD_RULES.test(plain(form.hintText))) cues.push('password length rules');
  if (form.inputs > 3) cues.push(`${form.inputs} inputs`);
  return cues;
}

/** True when a submit button of the form says log in / sign in and none says sign up. */
function loginSubmit(form: FormSignals | undefined): boolean {
  const text = form ? plain(form.submitText).replace(/[^a-z0-9]+/g, ' ') : '';
  return LOGIN_SUBMIT.test(text) && !SIGNUP_SUBMIT.test(text);
}

/** The page's own words and layout decide. Sign-in wins on a /login address; a forgot-password link or an already known account
 * only gives way to explicit new/create/set/confirm wording. */
export function classifyPasswordPage(page: PasswordPageContext): PasswordPageKind {
  const where = (() => { try { return new URL(page.url).pathname; } catch { return ''; } })();
  if (/\/login\b|signin|sign-in|identifier/i.test(page.url)) return { kind: 'signin', reason: 'a login address' };
  if (page.boxes < 1 || page.boxes > 2) return { kind: 'signin', reason: `${page.boxes} password boxes` };
  const strong = STRONG.test(page.boxText) ? 'a new/create/set/confirm password box'
    : STRONG.test(page.headings) ? 'a new/create/set password heading'
    : page.boxes === 2 ? 'two password boxes' : '';
  if (strong) return { kind: 'signup', reason: strong };
  if (page.forgotLink) return { kind: 'signin', reason: 'a forgot-password link' };
  if (loginSubmit(page.form)) return { kind: 'signin', reason: 'a log-in button' };
  // An email that is filled in (by the page or by this fill) is no sign that the account exists: a sign-up form shows its other cues.
  const cues = signUpCues(page.form);
  if (cues.length) return { kind: 'signup', reason: cues.slice(0, 3).join(', ') };
  if (page.prefilledAccount) return { kind: 'signin', reason: 'an account already filled in' };
  if (WEAK_TEXT.test(page.headings)) return { kind: 'signup', reason: 'a welcome/complete-your-account heading' };
  if (WEAK_PATH.test(where)) return { kind: 'signup', reason: 'a welcome/onboarding/set-password address' };
  return { kind: 'signin', reason: 'a password box with no new-password wording' };
}

/** What the page shows that the classifier needs. */
export async function readPasswordPageContext(page: Page): Promise<PasswordPageContext> {
  const seen = await page.evaluate(() => {
    const doc = (globalThis as unknown as { document: any }).document;
    const visible = (el: any): boolean => { const box = el.getBoundingClientRect(); return box.width > 0 && box.height > 0 && (globalThis as unknown as { getComputedStyle(e: unknown): { visibility: string } }).getComputedStyle(el).visibility !== 'hidden'; };
    const passwords: any[] = Array.from(doc.querySelectorAll('input[type="password"]')).filter(visible);
    const text = (el: any): string => [el.labels?.[0]?.textContent, el.getAttribute('aria-label'), el.getAttribute('placeholder'), el.getAttribute('name'), el.getAttribute('id'), el.getAttribute('autocomplete')].filter(Boolean).join(' ');
    const headings = Array.from(doc.querySelectorAll('h1,h2,h3,legend,[role="heading"]')).filter(visible).map((el: any) => el.textContent ?? '').join(' | ') + ' | ' + (doc.title ?? '');
    const forgot = Array.from(doc.querySelectorAll('a,button')).some((el: any) => visible(el) && /forgot|reset (?:your )?password|can(?:'|’)?t sign in/i.test(el.textContent ?? ''));
    const account = Array.from(doc.querySelectorAll('input')).some((el: any) => ['text', 'email', 'tel', ''].includes(el.type ?? '') && visible(el) && /@/.test(el.value ?? ''));
    // The form around the first password box (else the page): its fields, dropdowns, terms checkbox, submit buttons and the hint beside the box.
    const first = passwords[0];
    const scope: any = first?.closest('form') ?? doc;
    const inputs: any[] = (Array.from(scope.querySelectorAll('input,select,textarea')) as any[]).filter((el: any) => !['hidden', 'submit', 'button', 'checkbox', 'radio', 'image', 'file'].includes(el.type ?? '') && visible(el));
    const plainInputs = inputs.filter((el: any) => el.type !== 'password' && el.tagName !== 'SELECT');
    const dropdown = inputs.some((el: any) => el.tagName === 'SELECT') || Array.from(scope.querySelectorAll('[role="combobox"],[aria-haspopup="listbox"]')).some(visible);
    const termsBox = (Array.from(scope.querySelectorAll('input[type="checkbox"],[role="checkbox"]')) as any[]).some((el: any) => /terms|privacy|condicion|politica|terminos|aceptar|acepto|agree|accept|termos|aceito|conditions|accepte|datenschutz|agb|akzept|termini|accetto/i.test((el.labels?.[0]?.textContent ?? '') + ' ' + (el.closest('label')?.textContent ?? '') + ' ' + (el.parentElement?.textContent ?? '').slice(0, 300)));
    const submitText = (Array.from(scope.querySelectorAll('button,input[type="submit"],[role="button"]')) as any[]).filter(visible).map((el: any) => (el.textContent || el.value || '').trim()).filter(Boolean).join(' | ');
    let hintText = first ? first.getAttribute('placeholder') ?? '' : '';
    if (first) {
      const described = (first.getAttribute('aria-describedby') ?? '').split(/\s+/).map((id: string) => doc.getElementById(id)?.textContent ?? '').join(' ');
      let around = ''; let node: any = first.parentElement;
      for (let depth = 0; node && depth < 3; depth++, node = node.parentElement) { const t = node.textContent ?? ''; if (t.length <= 240) around = t; }
      hintText = `${hintText} ${described} ${around}`;
    }
    return { boxes: passwords.length, boxText: passwords.map(text).join(' | '), headings, forgot, account,
      form: { fieldText: plainInputs.map(text).join(' | '), inputs: inputs.length, dropdown, termsBox, submitText, hintText: hintText.slice(0, 400) } };
  }).catch(() => ({ boxes: 0, boxText: '', headings: '', forgot: false, account: false, form: undefined }));
  return { url: page.url(), boxes: seen.boxes, boxText: seen.boxText, headings: seen.headings, forgotLink: seen.forgot, prefilledAccount: seen.account, ...(seen.form ? { form: seen.form } : {}) };
}
