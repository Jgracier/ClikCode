/** Every action an agent can ask of ClikCode's browser, in one table: which tool it belongs to, what it does, which parameters it reads, and one
 * example. The tools' descriptions, their parameter lists and `help` are all made from this table, so they cannot disagree with each other or
 * with what the code accepts (actions.vitest.test.ts checks that they do not).
 *
 *   browser_use  looks at pages and acts on them (the generic browser)
 *   account_use  signs in, creates accounts, gets API keys and reads emailed codes (the parts that handle secrets)
 *
 * Parameter wording that differs between the two tools (target, text, seconds) is in TEXT below; everything else is described once, where the
 * parameter is defined. */

export type ToolKind = 'browser' | 'account';
export type Group = 'Look' | 'Go' | 'Act' | 'Browser' | 'People' | 'Sign in' | 'Email' | 'Keys' | 'Work';

export interface ActionSpec {
  readonly name: string;
  readonly kind: ToolKind;
  readonly group: Group;
  /** One or two sentences, in the order an agent needs them: what it does, then what the parameters change. */
  readonly does: string;
  /** The parameters it reads, besides action and tab (which every action takes). */
  readonly params: readonly string[];
  /** Arguments of one realistic call, as JSON. */
  readonly example: Readonly<Record<string, unknown>>;
}

const a = (name: string, kind: ToolKind, group: Group, does: string, params: readonly string[], example: Record<string, unknown> = {}): ActionSpec => ({ name, kind, group, does, params, example: { action: name, ...example } });

export const ACTIONS: readonly ActionSpec[] = [
  // ── browser_use: look ──
  a('observe', 'browser', 'Look', 'Read the whole page again, why_blank: true when it is stuck on Loading... or blank: reloads once and reports failed, blocked and error-status requests and console errors, so you can record the real cause, with a [ref=…] on every element. find: "words" shows only the lines that mention them (for a long page); full: true adds the header and footer; pages picks pages of a PDF.', ['find', 'full', 'pages', 'why_blank', 'seconds'], { find: 'pricing' }),
  a('screenshot', 'browser', 'Look', 'A picture of the page (full: true for the whole page, target for one element). Only for models that can see images.', ['full', 'target'], { full: true }),
  a('console', 'browser', 'Look', 'The tab\'s recent console messages and page errors (level, limit, clear).', ['level', 'limit', 'clear'], { level: 'error' }),
  a('network', 'browser', 'Look', 'Do the steps (or just wait seconds) while recording the page\'s API calls: method, address, status and the shape of each answer (bodies: true adds the bodies). find keeps calls whose address contains the words.', ['steps', 'seconds', 'find', 'bodies'], { steps: [{ do: 'click', target: 'e5' }], find: '/api/' }),
  a('evaluate', 'browser', 'Look', 'Run JavaScript in the page and get its JSON result. With target the code is a function that gets that element: "el => el.getBoundingClientRect().width". Password, code and card values read as empty.', ['expression', 'target'], { expression: 'document.title' }),
  // ── browser_use: go ──
  a('open', 'browser', 'Go', 'Go to a web address and return the page. new_tab: true opens it in another tab of yours; http_auth: true answers a site\'s own username/password box from the saved login.', ['url', 'new_tab', 'http_auth'], { url: 'https://example.com' }),
  a('back', 'browser', 'Go', 'Go back one page in the tab\'s history.', []),
  a('forward', 'browser', 'Go', 'Go forward one page in the tab\'s history.', []),
  a('reload', 'browser', 'Go', 'Reload the page.', []),
  a('tabs', 'browser', 'Go', 'List the tabs this chat opened (a chat only sees and changes its own).', []),
  a('switch', 'browser', 'Go', 'Make another of your tabs the current one: its number from tabs (index), or words of its title or address (text).', ['index', 'text'], { index: 1 }),
  a('close', 'browser', 'Go', 'Close this chat\'s tab, or just one of them with index.', ['index']),
  // ── browser_use: act ──
  a('click', 'browser', 'Act', 'Click an element. button: right or middle; count: 2 double-clicks; modifiers hold keys (["Shift"]); x and y click a point of the visible page (a canvas); accept_dialog: true answers yes to a confirm box the click raises.', ['target', 'button', 'count', 'modifiers', 'x', 'y', 'at', 'accept_dialog'], { target: 'e12' }),
  a('fill', 'browser', 'Act', 'Put text in a field, rich-text editor, date or time box, or dropdown (target + text). Leave text out for what only the user knows (name, email, phone, a password): it is filled from their saved profile or login, or they are asked privately, and you are not shown it.', ['target', 'text'], { target: 'e4', text: 'My key' }),
  a('choose', 'browser', 'Act', 'Pick an option of a dropdown: target + the option\'s text.', ['target', 'text'], { target: 'e7', text: 'Pro' }),
  a('press', 'browser', 'Act', 'Press one key or a combination: Enter, Escape, Tab, ArrowDown, a single character (/ or a), or modifiers joined with + (Control+a, Meta+k, Shift+Tab).', ['key'], { key: 'Enter' }),
  a('scroll', 'browser', 'Act', 'Scroll the page: direction up, down, left, right, top or bottom (default down), amount in pixels (default 600). With a target and no direction it is scrolled into view; with both, that element scrolls.', ['direction', 'amount', 'target'], { direction: 'down' }),
  a('hover', 'browser', 'Act', 'Move the pointer onto target (or x and y), for menus that open on hover.', ['target', 'x', 'y'], { target: 'e3' }),
  a('drag', 'browser', 'Act', 'Drag target onto to_target (the page\'s own drag and drop), or from x, y to to_x, to_y.', ['target', 'to_target', 'x', 'y', 'to_x', 'to_y'], { target: 'e3', to_target: 'e9' }),
  a('upload', 'browser', 'Act', 'Send a file to a file input (target is the input or its button). text is a file detail saved in the profile (logo_file) or an absolute path inside the workspace or this chat\'s downloads; nothing else can be sent.', ['target', 'text'], { target: 'e6', text: '/home/me/project/logo.png' }),
  a('wait', 'browser', 'Act', 'Wait for text to appear (gone: true: to disappear), or until network_idle, visible, hidden, enabled, disabled (target or selector) or url. seconds is the most to wait (default 30, up to 120). It returns what the page shows, not an error, when time runs out.', ['text', 'gone', 'until', 'selector', 'url', 'target', 'seconds'], { text: 'Deployed', seconds: 60 }),
  a('steps', 'browser', 'Act', 'Do several of click, fill, choose, press, scroll, wait, upload, hover, drag in order in one call. It stops at the first one that fails and shows the page.', ['steps'], { steps: [{ do: 'fill', target: 'e4', text: 'My key' }, { do: 'click', target: 'e9' }] }),
  // ── browser_use: the browser itself ──
  a('downloads', 'browser', 'Browser', 'List the files this chat\'s browser has downloaded. They are kept, and the path is reported as soon as the click that started a download returns.', []),
  a('dialog', 'browser', 'Browser', 'Answer an alert, confirm or prompt box the page is holding: accept_dialog: true to accept, text for a prompt\'s answer; otherwise it is dismissed.', ['accept_dialog', 'text'], { accept_dialog: true }),
  a('viewport', 'browser', 'Browser', 'Set how the tab presents itself: width and height, scale, mobile, a device by name ("iPhone 15"), geolocation, timezone, locale. reset: true undoes it; with nothing given it says what is set.', ['width', 'height', 'scale', 'mobile', 'device', 'reset', 'geolocation', 'timezone', 'locale'], { device: 'iPhone 15' }),
  a('pdf', 'browser', 'Browser', 'Print the page to a PDF in this chat\'s downloads (landscape, file_name).', ['landscape', 'file_name']),
  a('cookies', 'browser', 'Browser', 'List the site\'s cookies by name, domain and expiry (never their values); clear: true removes them. url names another site.', ['url', 'clear']),
  a('permissions', 'browser', 'Browser', 'Let the site use camera, microphone, geolocation, notifications or clipboard (grant), or refuse them (deny). Everything is refused until granted.', ['url', 'grant', 'deny'], { grant: ['geolocation'] }),
  a('auth', 'browser', 'Browser', 'Answer a site\'s own username/password box (HTTP Basic or Digest) with the saved login for that origin only: url (default the open page), label to pick a login. clear: true turns it off.', ['url', 'label', 'clear']),
  // ── browser_use: people ──
  a('handoff', 'browser', 'People', 'Give the user a link to a live view of this tab on their phone, for what only they can do (a CAPTCHA, a code sent to their phone, a payment). It returns the link at once; call handoff again to wait until they tap Done.', []),
  // ── account_use: sign in ──
  a('login', 'account', 'Sign in', 'Sign in on the open page with the saved login for the site, asking the user privately when there is none. new_account: true asks for a different account.', ['new_account']),
  a('add_login', 'account', 'Sign in', 'Ask the user for a login in one private form (email and password) and save it for the website in url, so a later login or sign-in uses it. With no url it asks for the website too. label starts the email field; you are never shown the password.', ['url', 'label']),
  a('forget_login', 'account', 'Sign in', 'Forget the saved login(s) for a site: host (default the open page), or label to forget just one.', ['host', 'url', 'label']),
  a('profile', 'account', 'Sign in', 'The user\'s autofill details (name, email, phone, address): list them, save fields, or ask for details a task needs with ask_fields (privately, once). They fill forms for you; you are never shown the private ones.', ['fields', 'label', 'ask', 'ask_fields', 'custom']),
  a('oauth_connect', 'account', 'Sign in', 'Connect a ClikDeploy connector\'s OAuth app by pressing through the provider\'s consent screens (target = the connector id: slack, github). It stops with a plain reason at a password, a payment or a CAPTCHA.', ['target'], { target: 'slack' }),
  // ── account_use: email ──
  a('email_connect', 'account', 'Email', 'One consent in this browser connects the signed-in Gmail (read-only). After that read_email_code and open_email_link read mail through Gmail and wait for it to arrive.', []),
  a('read_email_code', 'account', 'Email', 'Wait for an emailed verification code and return it (from: sender, subject: words from the subject, seconds: how long, default 90).', ['from', 'subject', 'account', 'seconds'], { from: 'github.com' }),
  a('open_email_link', 'account', 'Email', 'Find the newest email from a sender and open a link in it (link: words or domain of the link), in one call. For verification and sign-in emails.', ['from', 'subject', 'link', 'account', 'seconds'], { from: 'github.com' }),
  // ── account_use: keys ──
  a('capture_secret', 'account', 'Keys', 'On the page where a key is created or shown: press the Create button (target) and take the key. It checks the key against its service, saves it to the ClikCode Secrets Manager and sends it where send_to says. You never see it. With no target it takes a key the page already shows. A connector that needs a plain value beside the key (Knack app_id, Kommo subdomain): send_to {to:\'clikdeploy-connection\', with:{integration:\'knack\'}, values:{app_id:\'...\'}}; a wrong name answers with the allowed ones.', ['target', 'secret_name', 'send_to', 'vendor', 'owner', 'env', 'paste'], { target: 'e14', secret_name: 'acme/key', send_to: { to: 'clikdeploy-secret', with: { key: 'ACME_API_KEY' } } }),
  a('send_secret', 'account', 'Keys', 'Send a saved key again, or somewhere else, without seeing it: secret (its name; acme/key and acme/api-key are the same) + to and with, or send_to (a connector value beside the key: send_to {to:\'clikdeploy-connection\', with:{integration:\'kommo\'}, values:{subdomain:\'acme\'}}).', ['secret', 'to', 'with', 'send_to'], { secret: 'acme/key', to: 'clikdeploy-secret', with: { key: 'ACME_API_KEY' } }),
  a('secrets', 'account', 'Keys', 'List the keys saved in the ClikCode Secrets Manager: name, the site it is for and dates, never values; target filters by words. Check here before capturing a key again, and use the name with send_secret.', ['target'], { target: 'acme' }),
  a('read_value', 'account', 'Keys', 'Read a plain value the page labels (label: "Application ID", "Account ID", "Subdomain", "Workspace ID"), without running JavaScript. Refuses anything secret (a label naming a key, secret, token or password; a long opaque string). A short value is returned; an id that looks opaque, or any value when secret_name is given, is saved in the Secrets Manager and returned only as a name, to pass to send_to values as "secret:<name>" so you never see it.', ['label', 'secret_name', 'vendor', 'owner'], { label: 'Application ID', secret_name: 'knack/app-id' }),
  a('accounts', 'account', 'Sign in', 'List the saved sign-ins: name, base URL, how it signs in (password, or via google/github) and the account, never a password; target filters. To record that a site was signed in to through a provider, give target (the site), method and fields {email}.', ['target', 'method', 'fields'], { target: 'supabase' }),
  // ── account_use: work ──
  a('queue', 'account', 'Work', 'The durable list of vendor tasks: record or update one with task (one per vendor and kind; status needs-human with a reason when only the user can finish it), or list them with tasks: true.', ['task', 'tasks', 'task_status', 'task_reason'], { tasks: true }),
  a('notes', 'account', 'Work', 'Read (host alone) or add (note) what was learned on a site: the address that worked, the order of screens, what was missing. It is shown again whenever a page on that host is opened. Never a key or password.', ['host', 'note'], { note: 'The key page is under Settings > API.' }),
  a('recipe', 'account', 'Work', 'Save the steps of a sign-up or key capture that worked (by control text, never secrets), list them, get one, or run one (replays it and stops for the user at a CAPTCHA, a code, a payment or a review page). recipe_op: save, get, run, list.', ['recipe_op', 'host', 'login_route', 'steps', 'key_page', 'capture_hint'], { recipe_op: 'list' }),
  a('preflight', 'account', 'Work', 'One check, with no agent in it, that this computer is ready for sign-up work: the browser starts, Google is signed in, Gmail is readable.', []),
];

/** `help` is part of both tools. */
export const HELP = 'help';

export const actionsOf = (kind: ToolKind): readonly ActionSpec[] => ACTIONS.filter(spec => spec.kind === kind);
export const specOf = (name: string): ActionSpec | undefined => ACTIONS.find(spec => spec.name === name);
export const toolNameOf = (kind: ToolKind): 'browser_use' | 'account_use' => (kind === 'browser' ? 'browser_use' : 'account_use');
export const ALL_ACTION_NAMES: readonly string[] = [...ACTIONS.map(spec => spec.name), HELP];

/** Every parameter an action of this tool reads: what the tool's parameter list has to carry. */
export function paramsOf(kind: ToolKind): ReadonlySet<string> {
  const out = new Set<string>(['action', 'tab', 'topic']);
  for (const spec of actionsOf(kind)) for (const name of spec.params) out.add(name);
  if (kind === 'browser') out.add('with_screenshot');
  return out;
}

/** The actions of a tool, grouped as the description shows them: `LOOK observe · screenshot …`. */
export function listing(kind: ToolKind): string {
  const groups = new Map<Group, string[]>();
  for (const spec of actionsOf(kind)) groups.set(spec.group, [...(groups.get(spec.group) ?? []), spec.name]);
  return [...groups].map(([group, names]) => `${group.toUpperCase()}: ${names.join(' · ')}`).join('. ');
}

/** What an agent gets for a call to the wrong tool: where the action lives and how to call it there. */
export function elsewhere(kind: ToolKind, action: string): string | undefined {
  const spec = specOf(action);
  if (!spec || spec.kind === kind) return undefined;
  return `${action} is an action of ${toolNameOf(spec.kind)}, not ${toolNameOf(kind)}. Call ${toolNameOf(spec.kind)} with the same arguments.`;
}

/** The full usage of one action: what it does, the parameters it reads (described by the tool that owns them), and an example call. */
export function usage(spec: ActionSpec, describeParam: (name: string) => string | undefined): string {
  const lines = [`${spec.name} (${toolNameOf(spec.kind)}): ${spec.does}`];
  if (spec.params.length) lines.push('Parameters:', ...spec.params.map(name => `  ${name}: ${describeParam(name) ?? ''}`.trimEnd()));
  lines.push(`Example: ${JSON.stringify(spec.example)}`);
  return lines.join('\n');
}

/** `help` with no topic: every action in a line, with its example. */
export function overview(kind: ToolKind, extra: string): string {
  const lines = actionsOf(kind).map(spec => `${spec.name}: ${spec.does.split(/(?<=\.)\s/)[0]} e.g. ${JSON.stringify(spec.example)}`);
  return [`${toolNameOf(kind)} actions:`, ...lines, '', 'help with topic = an action name gives its parameters in full.', extra].filter(line => line !== undefined).join('\n');
}
