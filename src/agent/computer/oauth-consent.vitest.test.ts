import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listTasks } from './work-queue.js';
import { OPENS_ANOTHER_APP, authorizationUrl, classifyStuck, oauthConnect, type ConsentStop, startFailure, callbackState, GENERIC_ACTIONS, nextPress, readConsent, decideSelectors, providerFor, scopeTicks, scopesTicked, googleStep, type ScopeBox, stopReason, type Control } from './oauth-consent.js';

const press = (...names: string[]): Control[] => names.map(name => ({ name, leaf: false }));
const pick = (host: string, controls: Control[], text = '', options: { email?: string; skipAccount?: boolean } = {}): string | undefined => {
  const next = nextPress(host, controls, text, options);
  return next ? controls[next.index]!.name : undefined;
};

describe('provider table', () => {
  it('finds the provider family by host', () => {
    expect(providerFor('accounts.google.com')?.id).toBe('google');
    expect(providerFor('login.microsoftonline.com')?.id).toBe('microsoft');
    expect(providerFor('github.com')?.id).toBe('github');
    expect(providerFor('acme.slack.com')?.id).toBe('slack');
    expect(providerFor('auth.atlassian.com')?.id).toBe('atlassian');
    expect(providerFor('www.notion.so')?.id).toBe('notion');
    expect(providerFor('app.unknown-vendor.io')).toBeUndefined();
  });

  it('Google: the account first, then Advanced, Go to (unsafe), Continue', () => {
    const google = 'accounts.google.com';
    const chooser = press('Use another account', 'Me me@example.com', 'Other other@example.com');
    expect(pick(google, chooser, '', { email: 'me@example.com' })).toBe('Me me@example.com');
    // Once chosen on this page, it is not chosen again.
    expect(pick(google, chooser, '', { email: 'me@example.com', skipAccount: true })).toBeUndefined();
    expect(pick(google, [{ name: 'Advanced', leaf: true }, ...press('Back to safety')])).toBe('Advanced');
    expect(pick(google, press('Go to ClikDeploy (unsafe)', 'Back to safety'))).toBe('Go to ClikDeploy (unsafe)');
    expect(pick(google, press('Cancel', 'Continue'))).toBe('Continue');
    expect(pick(google, press('Cancel', 'Allow'))).toBe('Allow');
  });

  it('Google: the account chip on the signing-back-in and consent pages is never pressed as an account', () => {
    const chip = [...press('gracierdigital@gmail.com selected. Switch account', 'Cancel', 'Continue'), { name: 'gracierdigital@gmail.com', leaf: true }];
    expect(pick('accounts.google.com', chip, '', { email: 'gracierdigital@gmail.com' })).toBe('Continue');
    const consentChip = press('gracierdigital@gmail.com', 'Cancel', 'Continue');
    expect(pick('accounts.google.com', consentChip, '', { email: 'gracierdigital@gmail.com', account: false })).toBe('Continue');
    expect(nextPress('accounts.google.com', [{ name: 'Advanced', leaf: true }], '')?.phase).toBe('notice');
    expect(nextPress('accounts.google.com', press('Cancel', 'Continue'), '')?.phase).toBe('grant');
  });

  it('Google: pages are told apart by address path and words', () => {
    expect(googleStep('https://accounts.google.com/v3/signin/accountchooser?x=1', '')).toBe('chooser');
    expect(googleStep('https://accounts.google.com/signin/oauth/warning', '')).toBe('warning');
    expect(googleStep('https://accounts.google.com/signin/oauth/id', '')).toBe('identity');
    expect(googleStep('https://accounts.google.com/signin/oauth/v3/consent', '')).toBe('consent');
    expect(googleStep('https://accounts.google.com/v3/signin/challenge/pwd', '')).toBe('challenge');
    expect(googleStep('https://accounts.google.com/signin/oauth/error', '')).toBe('error');
    expect(googleStep('https://accounts.google.com/x', 'Google hasn\u2019t verified this app')).toBe('warning');
    expect(googleStep('https://accounts.google.com/x', 'ClikDeploy wants additional access to your Google Account')).toBe('consent');
    expect(googleStep('https://example.com/', '')).toBeUndefined();
  });

  it('never picks the signed-in or switch-account entries as the account', () => {
    expect(pick('accounts.google.com', press('Sign out me@example.com', 'Remove me@example.com'), '', { email: 'me@example.com' })).toBeUndefined();
  });

  it('other families', () => {
    expect(pick('github.com', press('Cancel', 'Authorize ClikDeploy'))).toBe('Authorize ClikDeploy');
    expect(pick('acme.slack.com', press('Cancel', 'Allow'))).toBe('Allow');
    expect(pick('auth.atlassian.com', press('Cancel', 'Accept'))).toBe('Accept');
    expect(pick('www.notion.so', press('Cancel', 'Allow access'))).toBe('Allow access');
    expect(pick('login.microsoftonline.com', press('No', 'Yes'), 'Stay signed in?')).toBe('No');
    expect(pick('login.microsoftonline.com', press('No', 'Yes'), 'Pick an account')).toBeUndefined();
    expect(pick('login.microsoftonline.com', press('Cancel', 'Accept'))).toBe('Accept');
  });

  it('generic vendors: Allow / Authorize / Accept / Grant access, and Continue only on a permission screen', () => {
    for (const label of ['Allow', 'Authorize', 'Accept', 'Grant access', 'Authorize app']) expect(pick('app.vendor.io', press('Deny', label))).toBe(label);
    expect(pick('app.vendor.io', press('Continue'), 'Welcome back, sign in to continue')).toBeUndefined();
    expect(pick('app.vendor.io', press('Continue'), 'Acme wants to access your account')).toBe('Continue');
    expect(GENERIC_ACTIONS.length).toBeGreaterThan(1);
  });

  it('never presses a refusal, a sign-out or a sign-up, or a long sentence that merely contains Allow', () => {
    expect(pick('app.vendor.io', press('Deny', 'Cancel', 'Do not allow', 'Sign up', 'Allow all cookies from partners and advertisers today'))).toBeUndefined();
    expect(pick('app.vendor.io', press('Sign out'))).toBeUndefined();
  });
});

describe('stopReason', () => {
  it('stops at a password box, a code, or a captcha, and not at a plain consent page', () => {
    expect(stopReason('Sign in', true, false)).toContain('login password');
    expect(stopReason('Enter code', false, true)).toContain('verification code');
    expect(stopReason('We sent a text message with a code', false, false)).toContain('verification code');
    expect(stopReason('Please verify you are human. I\'m not a robot', false, false)).toBe('a captcha');
    expect(stopReason('Acme wants to access your Google Account. Allow', false, false)).toBeUndefined();
  });
});

describe('callbackState', () => {
  const redirect = 'https://clikdeploy.example/api/oauth/callback';
  it('knows the landing page, what it says, and other pages', () => {
    expect(callbackState('https://github.com/login/oauth/authorize', redirect, 'Authorize')).toBe('elsewhere');
    expect(callbackState(`${redirect}?code=x&state=y`, redirect, 'Slack connected. You can close this window.')).toBe('connected');
    expect(callbackState(`${redirect}?error=access_denied`, redirect, 'Connection failed: access denied')).toBe('problem');
    expect(callbackState(`${redirect}?code=x`, redirect, 'Loading')).toBe('waiting');
    expect(callbackState('https://x.test/oauth/callback?code=1', undefined, 'Connected')).toBe('connected');
  });
});

describe('authorizationUrl', () => {
  it('reads the URL from JSON or from a plain line', () => {
    expect(authorizationUrl('{"status":"ok","data":{"authorizationUrl":"https://v.example/auth?a=1&b=2"}}')).toBe('https://v.example/auth?a=1&b=2');
    expect(authorizationUrl('Open this URL to authorize:\nhttps://v.example/auth?x=1.\n')).toBe('https://v.example/auth?x=1');
    expect(authorizationUrl('{"status":"error","message":"nope"}')).toBeUndefined();
  });

  it('never takes an error document\'s type address (errors.clikdeploy.com) for the authorization URL', () => {
    const problem = '{"type":"https://errors.clikdeploy.com/VALIDATION_ERROR","title":"Validation failed","status":400,"detail":"Supabase declares no OAuth scopes","instance":"https://clikdeploy.com/api/connectors/supabase/oauth/start"}';
    expect(authorizationUrl(problem)).toBeUndefined();
    expect(authorizationUrl(`Error: ${problem}`)).toBeUndefined();
    expect(authorizationUrl('see https://errors.clikdeploy.com/VALIDATION_ERROR for details')).toBeUndefined();
    expect(authorizationUrl('{"data":{"state":"s","authorizationUrl":"https://v.example/a"},"type":"https://errors.clikdeploy.com/X"}')).toBeUndefined();
  });

  it('prefers the authorizationUrl field over other URLs in the document', () => {
    expect(authorizationUrl('{"data":{"docs":"https://d.example/help","authorizationUrl":"https://v.example/a"}}')).toBe('https://v.example/a');
  });
});

describe('startFailure', () => {
  it('reports the real message of an error document', () => {
    expect(startFailure('{"type":"https://errors.clikdeploy.com/VALIDATION_ERROR","status":400,"detail":"Supabase declares no OAuth scopes, so the request would be rejected."}')).toBe('Supabase declares no OAuth scopes, so the request would be rejected.');
    expect(startFailure('{"success":false,"error":"OAuth client not configured for x"}')).toBe('OAuth client not configured for x');
    expect(startFailure('boom\nline two')).toBe('boom line two');
  });
});

describe('a stuck page is reported with its words', () => {
  const stuck = async (text: string, options: { stateDir?: string; controls?: Control[] } = {}): Promise<Error> => {
    const page = {
      url: () => 'https://api.vendor.example/v1/oauth/authorize?client_id=abc&state=zzz',
      isClosed: () => false,
      goto: async () => undefined,
      waitForTimeout: async () => undefined,
      // readControls passes an argument; the page-text read does not.
      evaluate: async (_fn: unknown, arg?: unknown) => (arg === undefined ? text : (options.controls ?? [])),
      locator: () => ({ count: async () => 0 }),
    } as unknown as import('playwright-core').Page;
    const error = await oauthConnect('vendor', page, { start: async () => ({ url: 'https://api.vendor.example/v1/oauth/authorize?redirect_uri=https%3A%2F%2Fcd.example%2Fcallback', stop: () => undefined }), status: async () => ({ connected: false }), timeoutMs: 20_000, ...(options.stateDir ? { stateDir: options.stateDir } : {}) }).then(() => undefined, (e: Error) => e);
    return error!;
  };

  it('includes the JSON error body and classifies an unrecognized client', async () => {
    const error = await stuck('{"message":"Unrecognized client_id"}');
    expect(error.message).toContain('JSON error: "{"message":"Unrecognized client_id"}"');
    expect(error.message).toContain('does not recognize the OAuth client');
    expect((error as ConsentStop).reason).toBeUndefined();
  });

  it('truncates the page text to about 300 characters, masks tokens and addresses, and says what it is', async () => {
    const error = await stuck(`You have no API credits. Add credits to continue. me@example.com ${'x'.repeat(40)} ${'filler '.repeat(100)}`);
    expect(error.message).toContain('Page text: "You have no API credits.');
    expect(error.message).not.toContain('me@example.com');
    expect(error.message).not.toContain('x'.repeat(40));
    expect(error.message.length).toBeLessThan(900);
    expect(error.message).toContain('wants payment');
  });

  it('records a payment-class stop in the human queue with reason payment', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cc-oauth-'));
    try {
      const error = await stuck('Out of credits. Add credits or a billing method to continue.', { stateDir: dir });
      expect((error as ConsentStop).reason).toBe('payment');
      expect(error.message).toContain('Recorded in the human queue');
      const [task] = await listTasks(dir);
      expect(task).toMatchObject({ vendor: 'vendor', kind: 'oauth-app', status: 'needs-human', reason: 'payment', connectors: ['vendor'] });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('does not record anything for an unrecognized client', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cc-oauth-'));
    try {
      await stuck('{"message":"Unrecognized client_id"}', { stateDir: dir });
      expect(await listTasks(dir)).toHaveLength(0);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('classifies captcha and MFA/SMS words', () => {
    expect(classifyStuck('Please verify you are human')?.kind).toBe('captcha');
    expect(classifyStuck('We sent a code to your phone by text message')?.kind).toBe('mfa');
    expect(classifyStuck('Acme wants to access your account')).toBeUndefined();
  });
});

describe('generic consent recognition', () => {
  const supabaseText = 'Organization to grant API access to\naccess permissions\nShow detailed permissions\nAuthorize ClikDeploy\nCancel';
  const supabase = press('Show detailed permissions', 'Authorize ClikDeploy', 'Cancel');

  it('recognizes the Supabase authorize page on an unknown host and presses Authorize ClikDeploy', () => {
    expect(pick('supabase.com', supabase, supabaseText)).toBe('Authorize ClikDeploy');
    expect(nextPress('supabase.com', supabase, supabaseText)?.consent).toBe(true);
  });

  it('accepts Allow / Approve / Continue as <account> beside a refusal, when the page names the app or the callback', () => {
    for (const label of ['Approve', 'Accept', 'Grant access', 'Continue as Jo Doe', 'Authorize']) {
      expect(pick('app.vendor.io', press(label, 'Deny'), 'ClikDeploy wants access')).toBe(label);
    }
    expect(pick('app.vendor.io', press('Approve', 'Cancel'), 'Redirecting to clikdeploy.example after approval')).toBe('Approve');
    expect(readConsent(press('Approve', 'Cancel'), 'Redirect to app.example', { redirectHost: 'app.example' }).consent).toBe(true);
  });

  it('does not treat a page that never names the app, or has no refusal, as consent', () => {
    expect(readConsent(press('Approve', 'Cancel'), 'Approve this purchase order').consent).toBe(false);
    expect(readConsent(press('Approve'), 'ClikDeploy wants access').consent).toBe(false);
  });

  it('never presses on a payment, missing-credits or captcha page', () => {
    expect(pick('supabase.com', supabase, `${supabaseText}\nYou have no credits. Add a payment method.`)).toBeUndefined();
    expect(pick('supabase.com', supabase, `${supabaseText}\nPlease verify you are human. I'm not a robot`)).toBeUndefined();
    expect(pick('supabase.com', press('Authorize ClikDeploy', 'Cancel'), 'Upgrade your plan to continue. Card number')).toBeUndefined();
  });

  it('does not press Continue with Google as consent, but prefers it, then GitHub, on a login page', () => {
    const login = press('Continue with GitHub Last used', 'Continue with Google', 'Sign in');
    expect(pick('supabase.com', login, 'Welcome back')).toBe('Continue with Google');
    expect(pick('supabase.com', press('Continue with GitHub Last used', 'Sign in'), 'Welcome back')).toBe('Continue with GitHub Last used');
    expect(pick('supabase.com', press('Sign in'), 'Welcome back')).toBeUndefined();
  });
});

describe('consent selectors', () => {
  it('accepts a preselected or single option and chooses the only one', () => {
    expect(decideSelectors([])).toEqual({ choose: [] });
    expect(decideSelectors([{ label: 'Organization', options: ['A', 'B'], selected: 'A' }])).toEqual({ choose: [] });
    expect(decideSelectors([{ label: 'Organization', options: ['Acme'] }])).toEqual({ choose: [{ selector: 0, option: 'Acme' }] });
  });
  it('stops and lists the options when there are several and none is chosen', () => {
    const plan = decideSelectors([{ label: 'Organization', options: ['Acme', 'Beta'] }]);
    expect('stop' in plan && plan.stop).toContain('Acme | Beta');
  });
});

describe('Google granular consent and the unverified-app chain', () => {
  const google = 'accounts.google.com';
  const granular = 'ClikDeploy wants access to your Google Account me@example.com Select all Select what ClikDeploy can access View your Google Fit activity View your sleep data Make sure you trust ClikDeploy Cancel Continue';
  const box = (index: number, name: string, checked = false): ScopeBox => ({ index, name, checked });

  it('ticks only "Select all" when it is offered and nothing is ticked', () => {
    const boxes = [box(0, 'Select all'), box(1, 'View your Google Fit activity'), box(2, 'View your sleep data')];
    expect(scopeTicks(boxes, granular)).toEqual([0]);
    expect(scopesTicked(boxes)).toBe(false);
    expect(scopesTicked(boxes.map(b => ({ ...b, checked: true })))).toBe(true);
  });

  it('ticks every unticked scope box when there is no Select all, and leaves ticked ones', () => {
    expect(scopeTicks([box(0, 'View activity', true), box(1, 'View sleep'), box(2, 'View location')], granular)).toEqual([1, 2]);
  });

  it('ticks the rest when Select all is ticked but a scope is not', () => {
    expect(scopeTicks([box(0, 'Select all', true), box(1, 'View activity', true), box(2, 'View sleep')], granular)).toEqual([2]);
  });

  it('does nothing when all is ticked, there are no boxes, or the boxes are not scopes', () => {
    expect(scopeTicks([box(0, 'Select all', true), box(1, 'View activity', true)], granular)).toEqual([]);
    expect(scopeTicks([], granular)).toEqual([]);
    expect(scopeTicks([box(0, 'Remember me'), box(1, 'Send me marketing offers')], granular)).toEqual([]);
  });

  it('never ticks on a page that does not name the app, or on payment, credits or captcha pages', () => {
    const boxes = [box(0, 'Select all'), box(1, 'View data')];
    expect(scopeTicks(boxes, 'Some other app wants access to your account Continue')).toEqual([]);
    expect(scopeTicks(boxes, 'ClikDeploy: add a payment method. Card number Select all')).toEqual([]);
    expect(scopeTicks(boxes, 'ClikDeploy wants access. You have no credits. Select all')).toEqual([]);
    expect(scopeTicks(boxes, 'ClikDeploy wants access. Please verify you are human. I\'m not a robot')).toEqual([]);
  });

  it('recognizes the app by the redirect host too', () => {
    expect(scopeTicks([box(0, 'Select all')], 'Acme wants access to your account', { appNames: ['Other'], redirectHost: 'acme.example' })).toEqual([]);
    expect(scopeTicks([box(0, 'Select all')], 'Sending to acme.example now', { appNames: ['Other'], redirectHost: 'acme.example' })).toEqual([0]);
  });

  it('presses Continue on the granular page', () => {
    expect(pick(google, press('Cancel', 'Continue'), granular)).toBe('Continue');
  });

  it('walks the warning chain: Advanced, Go to (unsafe), signing back in Continue, second notice Continue', () => {
    const warning = 'Google hasn\'t verified this app. ClikDeploy has not completed the Google verification process. Back to safety Advanced';
    expect(pick(google, [{ name: 'Back to safety', leaf: false }, { name: 'Advanced', leaf: true }], warning)).toBe('Advanced');
    const opened = warning + ' Go to ClikDeploy (unsafe)';
    expect(pick(google, press('Back to safety', 'Go to ClikDeploy (unsafe)'), opened)).toBe('Go to ClikDeploy (unsafe)');
    const signBack = 'You\'re signing back in to ClikDeploy me@example.com. If you continue, ClikDeploy will be able to access the info you already allowed. Cancel Continue';
    expect(pick(google, press('Cancel', 'Continue'), signBack)).toBe('Continue');
    const second = 'This app hasn\'t been verified by Google yet. Only proceed if you know and trust the developer. Cancel Continue';
    expect(pick(google, press('Cancel', 'Continue'), second)).toBe('Continue');
  });

  it('does not press Continue on a payment page', () => {
    expect(pick(google, press('Continue'), 'Add a payment method. Card number. Continue')).toBeUndefined();
  });
});

describe('links that open another program', () => {
  it('are told apart from the page\'s own addresses', () => {
    for (const href of ['mailto:me@example.com', ' MAILTO:me@example.com', 'tel:+15555550100', 'sms:+15555550100', 'callto:me', 'facetime:me@example.com', 'zoommtg://zoom.us/join']) expect(OPENS_ANOTHER_APP.test(href), href).toBe(true);
    for (const href of ['', '#', '/signin/oauth', 'signin?x=1', 'https://accounts.google.com/x', 'http://127.0.0.1:1/y', 'javascript:void(0)', 'about:blank']) expect(OPENS_ANOTHER_APP.test(href), href).toBe(false);
  });
});
