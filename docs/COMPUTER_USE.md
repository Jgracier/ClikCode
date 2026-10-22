# Computer use

ClikCode's agent can drive a browser of its own and the rest of the desktop. Both
are on by default; `/computer off` (or `clikcode computer off`) refuses new actions
and closes the browser, `on` brings them back.

| Tool | What it is for |
|---|---|
| `computer_web` | A Chrome with its own saved profile (Edge if Chrome is missing), shared by every terminal and VS Code window, never your personal profile. **Each chat gets its own tab**: a chat only sees, acts on and follows tabs it opened itself, so chats working at once do not collide. `close` closes that chat's tab only. |
| `computer_desktop` | Everything outside the page, through [cua-driver](https://github.com/trycua/cua) (a separate install): a popup window, a native dialog, another app. Give it a `pid` and `window_id` from `windows` to act on one window. |

Nothing here asks you anything of its own: in Auto mode these tools just run, and the
agent stops only for what it cannot do itself (a sign-in you must type, a choice
between accounts, a payment, a CAPTCHA).

## How the agent works a page

`open` and `observe` return the page; each element carries a `[ref=e12]` (`f1e2` inside a
frame) that the agent clicks or fills by, which works for unnamed chips, hidden radios and
elements in iframes alike. What is open (a dialog, a dropdown) is shown first, a page's
header, footer and long side menus are folded away (`observe` with `full: true` brings them
back), and a very long middle is trimmed. After an action the tool waits for the page to
settle, follows a new tab or popup the chat's own page opened, and returns **only what
changed** (plus any open dialog); `observe` shows the whole page again. `steps` runs several
clicks and fills in one call and stops at the first that fails, showing the page. `wait`
holds for words to appear or go, and `observe` with `find: "words"` shows just the lines that
mention them. A stale reference answers "the page has changed" with the current page.

**Every page can be read**, sign-in and signup forms included. What is never shown is the
*value* of a password, one-time-code or card field (masked in every view, and a screenshot is
withheld while one holds a value). There is no "sign-in page" mode to get stuck in.

## Signing in and filling forms

- **Autofill profiles** keep the details every signup form asks for (name, email, phone, address,
  company). A `fill` with no `text` takes them from the profile instead of asking; with several
  profiles you pick once per site. Create one with `/computer profile` (a private prompt in the
  chat), `clikcode computer profile --create` (questions in the terminal) or
  `clikcode computer profile --set phone=719-555-0123`; the agent can call `profile` (with
  `ask: true` to ask you, or `fields` to correct a value, for example a phone in the format a
  site wants). Passwords, codes and card numbers are never kept in one.
- **Custom profile details.** A task can need more than the standard fields: registering an OAuth
  app asks for an app name, a description, a privacy-policy address, a support email. The agent
  asks for exactly those in one private prompt, `profile` with `ask_fields: [{key, label, match?,
  optional?}]` (and `label` to keep them in a profile of their own, such as "ClikDeploy OAuth apps"),
  or saves what it already knows with `custom: {key: {label, value, match}}`;
  `clikcode computer profile --custom app_name="My App"` does the same by hand. `match` is the
  words a form may use for the field (`["app name", "application name"]`; without it the label is
  used). A later `fill` with no `text` takes those details from the profile, a field the agent
  named winning over the standard field its words also suggest ("Support email" is not your
  email). Details only: a value with a key or token in it is refused (that is `capture_secret`'s
  job), and a password, code or card field never matches. Not filled: file uploads such as a logo.
- **`fill` with no `text`** asks you in a private prompt (masked for password boxes), once for
  all such fields in the call; the agent is never shown the answer. This is how a signup
  form's name, address, phone and new password are filled.
- A password you create this way is kept: when the form goes (its password fields disappear)
  the login is saved to Secrets Manager under that site and the email the form held, so the
  account is not lost.
- **`login`** fills a saved login, or asks you in one prompt (an email-first page asks for
  email and password together). One saved login for the site is used silently; several: an
  arrow-key picker plus "Use a different account". Email-first, password and one-time-code
  pages are followed in turn; a code is asked for every time and never saved. A login is saved
  only after the browser leaves the sign-in page; a refused one is never saved, and a saved
  one a site refuses is asked about next time.
- `/computer login [url] [--new]` does it from the command line; `/computer logins` lists and
  removes saved logins (the model sees only a count).
- A CAPTCHA, a card, or MFA that needs hands: `handoff` returns a one-use link at once, served from
  this computer's Tailscale address, so the phone connects directly (no relay, no third-party host;
  the phone just has to be on the same tailnet). The agent gives you the link, then calls `handoff`
  again to wait until you tap Done. Without Tailscale a handoff says so, and the step is finished at
  the computer.
- **Each chat has its own tab** in the shared Chrome: a chat only sees, acts on and follows
  tabs it opened itself, so chats working at once do not collide. `close` closes that chat's
  tab only.

## Getting an API key without the agent seeing it

The agent signs in, sets the options, then makes one `capture_secret` call: the final
Create button, and `send_to`, saying where the key goes. Your request is the
authorization; there is no extra approval step.

1. **Find the key.** Press the site's own Copy button; or notice a file the click
   downloads (a service-account JSON); or recognise the key on the page. Only if
   none is clear does the private paste prompt appear.
2. **Check it.** The key is tried against its own service (Hugging Face, Google AI
   Studio, Together, OpenAI, Anthropic, Groq, Mistral, DeepSeek, OpenRouter), with
   a damaged copy as a control. A Google service-account JSON is tested by getting a
   token with it (signed here; only the signed request goes, to Google's own token
   address), retrying for about a minute if the key was just made, because Google is
   slow to accept a new one. A value the service refuses from a page that already
   showed it is **not saved**; a key the click just made is kept even if refused (the
   site shows it once) but is **not sent anywhere** until it checks out.
   Anything else is saved and marked "not checked", with the reason.
3. **Save** it to ClikCode Secrets Manager (always). The result says what it took (length,
   kind of text, and which control: "the site's Copy button next to 'Secret Key'"). When a
   page shows an access key id and a secret key, the Copy button whose label says secret
   is pressed, not the id's; a value equal to one already saved under another name is
   refused as the first value again. `paste: true` skips looking and asks you to paste.
4. **Send** it on, as `send_to` says. If a destination fails the key stays saved.

Once the click that makes the key has happened, a stop does not abandon the capture: it
is finished and saved, so an interruption cannot leave a live key at the site that the
vault never got. A downloaded key file is read and deleted at once.

**A destination is a name for a command, nothing more.** The command has `{{secret}}`
where the key goes and `{{slot}}` for anything the agent fills in:

```
send_to: { to: "clikdeploy-secret",  with: { key: "SALAD_API_KEY" } }
send_to: { to: "clikdeploy-compute", with: { provider: "GCP", field: "serviceAccountJson" } }
send_to: { to: "clikdeploy-connector", with: { integration: "googlesheets", client_id: "1234-abc.apps.googleusercontent.com" } }
send_to: { to: "clikdeploy-connection", with: { integration: "acme" } }
send_to: [ ...several of those... ]
```

Six ship as plain data (`clikdeploy-secret`, `clikdeploy-app-secret`,
`clikdeploy-compute`, `clikdeploy-connector`, `clikdeploy-connection`, `github-secret`). ClikDeploy destinations send secret-bearing JSON on stdin, so the credential is absent from process arguments. You add your own with one line, and the agent
can then use it by name; an unknown name is answered with the full list:

After ClikDeploy records a full connector test, `clikcode computer proof <id>` reads ClikDeploy's current verdict and updates a local `connector-proof` queue task. ClikCode stores that verdict for work tracking; ClikDeploy alone decides whether the connector is proven and publishable.

```
clikcode computer destination add my-vault --stdin "{{secret}}" -- vault kv put secret/{{path}} value=-
clikcode computer destination list | remove <name>
```

Only you can add one (the agent cannot), so what can ever run is decided by you, not
by a page the agent is reading. `{{secret|json}}` is the key inside a JSON string; a
destination's `--stdin` keeps the key out of the command line. Every result begins
`SAVED` or `Not saved:` and says what really happened, including a warning when a
click may have made the site create a key that was then not saved (delete it there).
`send_secret` (an action of `computer_web`) sends a saved key again, or somewhere else, with `{secret, to, with}`.

Once held, a key's exact value (and its base64, URL-encoded and JSON forms, and the
secret fields of a JSON file such as its private key, but not its public ids) is replaced with `[secret hidden]` in every tool result,
and a screenshot of a page showing it is withheld. With no Create button,
`capture_secret` takes the key a page already shows. The computer's shared clipboard
is never read.

## Updates without restarting

The computer tools are also built as `computer-tools.js` next to the program. Each call checks
that file and runs the newest copy, so a rebuilt ClikCode takes effect in a chat that is
already open: its worker, history and tab stay. Only the argument list and descriptions the
model was given when the chat began stay as they were, so a brand-new argument needs a new chat.

## In every harness

The tools run in the chat's worker, so they work the same in any harness:

- **MCP, automatically.** `clikcode mcp-serve` is a built-in server named `clikcode`,
  handed to every ACP harness session (and to Codex as `-c mcp_servers.clikcode.*`)
  as it starts. Nothing is installed or written into a harness's config; it ships in
  every ClikCode install and follows `/computer off`. `clikcode mcp list` shows it.
- **CLI, for anything else.** `clikcode computer tool <name> --args-json …`,
  `computer capture <name> --click <target> [--to clikdeploy-secret --with key=…]`,
  `computer store <name> --to clikdeploy-secret --with key=SALAD_API_KEY`,
  `computer secrets [--delete NAME | --export FILE | --import FILE]` (your own vault, no chat needed), `computer login`.

Private prompts need a chat window open; nothing else does.

## Where things live

`~/.clikcode/computer/vault/`: a random 32-byte key (`vault.key`, owner-only) and one
AES-256-GCM file per login or secret. No setup or password. A login belongs to a site
by host (a leading cloud-region label is ignored). The key sits beside the files, so
this protects against a copied folder, not against other programs running as you.

## Limits

- Some sites refuse automated browsers whatever is done.
- A key shown only as an image, or split across boxes, or sent only by email: use the
  paste prompt or `handoff`.
- The key is briefly in the `clikdeploy` command line, visible to the same OS user.
- A URL change is the only success signal for a sign-in; no site-independent proof
  exists.
- `computer_desktop observe` is refused while a browser tab holds a typed password, code or
  card number, since a screenshot would show it. Acting is allowed.

## Doing a long run of sign-ups and app registrations

What the browser tool does so a run does not depend on luck or on the user:

- **Waits report state.** A `wait` whose words do not appear is the page's answer, not a failed tool: the
  batch stops there, says how many later steps did not run, and shows what changed. A tab that closes
  itself (a sign-in popup) is read from the page's own state and the batch carries on from the tab left.
- **Calls run in order.** Two `computer_web` calls made together run one after the other, so a capture
  and the click that closes the one-time dialog it reads cannot race.
- **Capture takes every copy route.** `writeText`, `write` (ClipboardItem), `execCommand("copy")`, then the
  clipboard itself when it changed across the click. Copy buttons with qualifiers ("Copy client secret")
  are recognised; buttons that copy an id, name, link or command are not. The user is never the fallback:
  a failed capture tells the agent to reveal, copy or rotate, and `paste` is only for when the user said
  they would paste.
- **Emailed codes.** `read_email_code` (from/subject, optional Gmail account) reads the newest message in
  the signed-in Gmail in a tab of its own and returns the one-time code.
- **Sign-in choices.** The profile's `sso_email` is the account to pick at a Google account chooser, and a
  Google consent screen that asks for calendar, mail, files or contacts is flagged for declining.
- **Notes per site.** `notes` saves what worked (URL, order of screens, gotchas) for a host and shows it
  again when a page on that host is opened. Keys and passwords are refused.
- **Signup recipes.** `recipe` (`recipe_op` save / get / run / list) keeps the steps that worked for a signup
  or key capture at a host: `login_route` (`google`, `github`, `email`), the steps (controls named by visible
  text, never `eN` refs), `key_page`, `capture_hint`, and `verifiedAt`. Nothing secret is stored: text that
  looks like a key, token or password, or typed into a password/code field, is refused, and a `fill` with no
  text is filled from the profile autofill at replay. `run` replays through the same steps runner and stops at
  the first failure, returning the page change so the agent takes over from there. It also stops, and says so,
  at a captcha, an SMS/authenticator code, a payment page or a review page: those are for the person
  (`handoff`, `ask_user`, `queue`); nothing tries to solve or get around them. Opening a page on a host with a
  recipe mentions it. Recipes live in `computer/recipes/<host>.json` in the state dir.

- **Generated site passwords (on by default).** Like a phone's "Strong Password": when `computer_web` fills a sign-up or
  new-password form (two password boxes, a `new-password` box, or a sign-up page) it makes up a password for that site,
  types it into every password box, and keeps the login (site, email, password) in Secrets Manager once the form is gone.
  Nothing is typed by a person and no one password is shared across sites. The password is registered with the scrubber
  and never enters the model's context; the agent is told only that a login was saved. If the same site and email already
  have a saved login, its password is reused (a form filled twice never leaves the vault behind the account), and a
  password that a new one replaces is kept in the login as `previous_password`. It needs an https page, since the vault
  keeps https logins only.
  - **Policy.** 24 characters with upper, lower, digit and symbol by default. It reads the page's own requirements first:
    `minlength` / `maxlength` / `pattern` on the box, `aria-describedby` text, its `title`, and the hint text around the
    field ("at least 12 characters", "8-16 characters", "no special characters", "letters and numbers only", "special
    characters: ! @ #"), and fits the length, the symbols and any pattern.
  - **Retry.** If the page then shows an error next to the password box about length, characters or symbols, a new
    password is made under looser rules (shorter or longer as the error says; a short symbol set, then none), typed into
    every box, and the Create button pressed again, up to three retries in all, in a bounded loop. The agent hears that the
    site refused and how many tries it took, never the passwords. After three refusals it is told to hand off.
  - **Fallbacks.** `clikcode computer passwords off` turns generation off; a sign-up then uses the profile's `password`
    secret if one is set, else asks privately. A profile `password` is only this optional fallback now.
  - **Sign-in.** A `fill` with no text on a sign-in password box uses the site's saved login (generated ones included; a
    login saved at `example.com` is found at `www.example.com` and the other way round, and across a cloud region label).
    With none, and no profile password, the need is parked in the vendor queue (`needs-human`) with a clear note and the
    agent goes on; it no longer fails with "The user did not provide the values". `login` does the same as before.
- **Backup and restore of the vault.** `clikcode computer secrets --export <file>` writes every login, secret and
  profile as one encrypted file; `--import <file>` restores it (items already present are kept; `--overwrite` replaces
  them). The passphrase (at least 12 characters, asked twice on export) is typed hidden at a terminal; both commands refuse
  to run without one, so it never passes through an agent, a pipe or a log, and nothing but counts is printed. This is the
  one option chosen over a generated recovery key, because there is then nothing printed that could be copied into a
  model-visible channel or lost with the terminal scrollback. The file is scrypt (N=2^17) into AES-256-GCM. Losing the
  passphrase loses the backup; there is no recovery.
- **Typed-in formats and selectors in private prompts.** A question's `format` (`date`, `phone`, `zip`, `time`, or
  a pattern such as `##/##/####`) makes the box type the pattern itself, in the terminal and in the VS Code panel;
  `options` makes it a selector.

## Secrets in a profile

A profile can keep secrets next to its details: an optional fallback password for sign-ups when generated passwords are off (`password`), a recovery code, anything a form asks that is not a detail. The value goes to Secrets Manager; the profile only knows the name, and nothing returns the value to the agent. Set one with `clikcode computer profile --label Personal --secret password` (typed hidden), or the agent asks with `profile` `ask_fields` and `secret: true`. A fill with no text then puts it in the box it is for: the password secret fills password boxes on a sign-up only when generated passwords are off (a generated, per-site password comes first), another secret fills a box whose label matches its words.

## Vendor set-up at scale

- **The queue** (`queue` action, `clikcode computer queue`): one record per vendor and kind (OAuth app, API key, test account, webhook) with a status (`queued`, `working`, `done`, `needs-human`, `blocked`, `no-self-serve`), a reason when a person is needed (`captcha`, `sms`, `payment`, `identity`, `review`, `two-factor`) and a note. Agents record every outcome there instead of only saying it; `clikcode computer queue --reason captcha` is the list to work through together.
- **Secret records**: every captured secret carries its vendor, owner (the profile's sign-in email unless `owner` is given) and environment, plus created and rotated dates. `clikcode computer secrets` lists them without values; `--backfill --owner <email>` fills in secrets saved before records existed.
- **`network`**: runs steps (or just waits) while recording the page's API calls: method, address with query values dropped, status, the answer's shape, and request header names (never values). `bodies: true` adds truncated bodies with key-like values hidden. Use it to read the endpoints a vendor's own web app uses when its documentation is thin.
- **Making a test connection**: to run call tests against a vendor with consent (authorization-code) auth, run `clikdeploy integrations connect <id> --no-browser`, open the printed address in this browser signed in as the test account, and click Allow. The token goes to ClikDeploy; it never reaches the agent.

## Running unattended over many vendors

- **Sign-in order** (said to the agent on every sign-in or sign-up page): Google ("Continue with Google", no password, no email check), else GitHub (GitHub has no Google sign-in of its own, so it signs in with the saved GitHub login and a verification code read from the profile's mailbox), else the profile's email with, on a sign-up, a generated per-site password. A site with a free-form username uses the profile's `preferred_username`.
- **The profile answers sign-ins**: `login` with no saved login for a site fills the profile's sign-in email and, if one is set, its optional `password` secret instead of asking. Anything else it is asked (a one-time code, an account choice) is asked as before.
- **`clikcode computer unattended on`**: a private prompt about a site is never shown. The need is parked in the queue (`needs-human`, with a reason from what was asked: `captcha`, `two-factor`, `sms`, else `other`) and the agent is told to go on to the next vendor. The profile prompts are always shown, because they are the user's own. Clear the queue in batches: `clikcode computer queue --status needs-human`.

## Onboarding a ClikDeploy connector

The `onboard-connector` skill (`~/.claude/skills/onboard-connector/SKILL.md`) is the whole loop: research the vendor's docs, write the
spec through ClikDeploy's MCP tools (`search_tools` finds them; nothing is pinned), sign up (Google first, then Google through GitHub,
then the profile email + hidden password), `capture_secret`, `send_secret` to the built-in `clikdeploy-connection` destination
(`clikdeploy-connection-basic` for username + password), then test and publish. Those two destinations read the result back from ClikDeploy (`clikdeploy integrations show <id>`) and answer one line: `connected`, or `NOT connected: <reason>`; a command that printed success while nothing was stored is reported as not connected, and the key is never in the line. Captcha, SMS, payment, attestation and phone-approval
steps go to the queue (`queue`) and the loop moves on. ClikDeploy never browses; ClikCode never touches a spec's internals beyond the
schema ClikDeploy serves (`connector_spec_guide`).
