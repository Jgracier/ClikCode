# Computer use

ClikCode's agent can drive a browser of its own and the rest of the desktop. Both
are on by default; `/computer off` (or `clikcode computer off`) refuses new actions
and closes the browser, `on` brings them back.

| Tool | What it is for |
|---|---|
| `browser_use` | A Chrome with its own saved profile (Edge if Chrome is missing), shared by every terminal and VS Code window, never your personal profile. **Each chat gets its own tab**: a chat only sees, acts on and follows tabs it opened itself, so chats working at once do not collide. `close` closes that chat's tab only (see [Page control](#page-control) for tabs, history, scripts, screenshots and the console). |
| `computer_use` | Everything outside the page, through [cua-driver](https://github.com/trycua/cua) (a separate install: `clikcode computer driver install`): a popup window, a native dialog, another app. Give it a `pid` and `window_id` from `windows` to act on one window. See [Desktop control](#desktop-control-computer_use) for the actions and what each OS can do. |

They were called `computer_web` and `computer_desktop` before 2026-10-26; permission rules and MCP calls that use
those names still reach the same tools.

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

## Page control

Beyond `open`, `observe`, `click`, `fill` and `wait`, `browser_use` drives the page like a person at the keyboard.
Everything below uses only Playwright and the DevTools protocol, so it behaves the same on Linux, macOS and Windows.

| Action or option | What it does |
|---|---|
| `back`, `forward`, `reload` | Move through the tab's history, or reload. Answers plainly when there is no earlier or later page. |
| `tabs`, `switch`, `close` with `index` | `tabs` lists the tabs **this chat opened** (number, title, address, `*` for the one in front). `switch` takes `index` (or words of the title or address in `text`) and later actions act on that tab. `close` with `index` closes that one tab; without it, all of the chat's tabs. `open` with `new_tab: true` adds a tab. Another chat's tabs are never listed, switched to or closed. |
| `evaluate` | Run `expression` (a JavaScript expression, or a function that gets the element named by `target`) and return its JSON result, cut at 8,000 characters. |
| `click` with `button`, `count`, `modifiers`, `x`/`y` | Right or middle click, double (`count: 2`) or triple click, held Shift/Control/Alt/Meta (`ControlOrMeta` is Command on macOS). `x`/`y` alone click that point of the visible page (a canvas or map); with a `target`, they are an offset inside it. |
| `hover` | Move the pointer onto a `target` or `x`/`y`, for menus that open on hover. |
| `drag` | `target` onto `to_target` (the browser's own drag and drop), or `x`/`y` to `to_x`/`to_y`. |
| `screenshot` | The visible page, `full: true` for the whole page, or a `target` element. Only hosts that take images get one. |
| `with_screenshot: true` | On any action: the result also carries a picture of the page afterwards. |
| `press` | Any single character (`/`, `.`, a space, `é`), a Playwright key name (`Enter`, `ArrowDown`, `F5`) or a combination (`Control+a`, `Meta+k`, `Shift+Tab`). Nothing else is sent: no free text, no control characters. |
| `scroll` | `direction` up, down, left, right, top or bottom, `amount` in pixels (default 600). A `target` alone is scrolled into view; with a `direction` it scrolls inside that element (its nearest scrollable parent). The answer says where it ended up and whether that is the end. |
| `wait` | As before for `text` (and `gone`), and now `until`: `network_idle`, `visible`, `hidden`, `enabled`, `disabled` (of a `target` or CSS `selector`), `url` (the address contains `url`, or `/regex/`; with no `url`, any change). On a timeout it is not an error: the page as it is comes back. |
| `fill` | A rich-text editor (contenteditable) is written by insertion, with Shift+Enter between lines so a chat box does not send; a date, time, month or datetime-local box takes `2026-10-26`, `10/26/2026` or `3:45 PM` and says what format it wants if it refuses; range and colour inputs are set and announced; a dropdown is chosen by label or value; text up to 100,000 characters goes in at once. |
| `console` | The tab's recent console messages and uncaught page errors (200 kept), oldest first; `level` keeps that level and worse, `find` filters, `limit` caps, `clear` forgets them. Recording starts when the chat's tab is opened. |

**What stays hidden.** `evaluate`, `console`, `tabs` and screenshots go through the same hiding as the page view.
During an `evaluate`, every password, one-time-code and card field reports an empty `value`, a script that goes looking for one
(`type=password`, `autocomplete=cc-*`, `FormData`, `getOwnPropertyDescriptor`, form `.elements`) is refused, and the result is
scrubbed of those fields' values (also as base64 or URL-encoded), of key-shaped text-box values, of anything registered as a secret,
and of key-like text. This is defence in depth for an agent that should not read credentials, not a sandbox against a page that
fights back. A screenshot is withheld while a credential field holds a value or the page shows a key, as for `observe`.

Right-clicks, coordinate clicks, hovers and drags are not saved into an automatic signup recipe; a journey that used one is
simply not recorded, rather than recorded wrong.

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

  **What the link is.** A live view of the chat's real tab, not a picture that refreshes: Chrome pushes
  each frame as it paints it over one WebSocket (one frame in flight at a time, so a slow phone gets
  the newest, never a queue). For as long as the link is open the tab is laid out for the phone's own
  screen and touch (a phone-sized viewport, touch emulation, the phone's pixel density up to 2x), so
  the page reflows the way it would on the phone instead of being shrunk, and it is put back when you
  tap Done or the link ends. Touch reaches the page as real touch
  events (tap, drag, fling and pinch are tested; long press has not been tried); a computer's browser opening the link gets real mouse, wheel and keyboard instead.
  **Fields are the phone's own inputs, in place.** ClikCode tells the phone where the page's fields are on
  its screen (refreshed as the page moves, and each field keeps one number while the page keeps it), and
  the phone lays a real, invisible input exactly over each one: text, password, email, number,
  one-time-code and multi-line fields, dropdowns, and date, time, month, week and colour fields. A finger
  on a field therefore lands on an input of the phone itself, and the phone does what it does for any
  input: it focuses it and opens its keyboard (with the field's type, `inputmode`, `autocomplete` and
  Enter-key hint, so autofill, the password manager and the text-message code suggestion work) or its
  own picker. Nothing in the page asks the phone to open a keyboard, which is something Safari on an
  iPhone declines to do. What is entered goes into the real field on the page as it is typed (the whole
  value, selected and replaced with real input, so the page hears `input`; a choice or a date is set
  the way a person choosing it would, `input` and `change`), and the picture shows it arrive. A tap on a
  field is also sent to the page, so its own focus and caret show; a tap on a dropdown or date is kept
  from the page, whose pop-up would open unseen on the computer. A drag that starts on a field is a
  scroll (the input steps aside for it, and goes on being one when the finger leaves the picture), a tap
  anywhere else puts the keyboard away, and for a moment after a scroll the inputs wait until the page
  has said where its fields moved to. A field the page has switched off has no input over it. Checkboxes,
  radio buttons and buttons are tapped in the picture like anything else. A field inside an iframe (a
  payment form from another site, a CAPTCHA) is not tracked, so it gets no input; a computer's browser
  can still type into it with its own keyboard. A password's value is never read back from the page. Not
  tried on an iPhone yet.
  **Touch or mouse.** The button beside Done switches, and always names the other one (**Mouse** while
  in touch, **Touch** while in mouse). The link starts in touch on a phone or tablet and in mouse on a
  computer, and remembers the last choice on that device. *Touch*: the page is laid out for the phone
  and sees a touch screen (tap, drag, fling, and pinch to zoom, which are touch events to the page).
  *Mouse*: the page sees a mouse at the phone's width, no touch screen, so hover menus, `:hover` styles,
  dragging, text selection and drag-and-drop work. Your finger is the pointer: touching moves it (and
  hovers), a tap clicks, dragging drags, two fingers scroll, and a quick two-finger tap right-clicks.
  **Limits.** The view shows the page, not the browser's own windows: a file chooser, a permission
  prompt and a JavaScript dialog do not appear on the phone (a dialog is held for the agent, see
  Dialogs). It does not carry the phone's passkeys or biometrics to the site, because the browser is
  this computer's. Latency is the network round trip plus about one paint: on the same computer a tap
  was back as a new picture in about 10-20 ms; across a direct Tailscale path expect the path's round
  trip on top. A `viewport` emulation set earlier is replaced while the link is open and is not
  restored afterwards.
  **Safety.** The link carries a random one-use secret (24 random bytes) and only the Tailscale
  address answers. The socket refuses another site's page as `Origin`, one phone drives at a time (a
  reconnect takes over), the link ends when you tap Done, after 10 idle minutes, or when the chat
  stops, and the page is served with a content-security policy that allows only its own socket.
- **Each chat has its own tab** in the shared Chrome: a chat only sees, acts on and follows
  tabs it opened itself, so chats working at once do not collide. `close` closes that chat's
  tab only.

## Files, dialogs and the browser's environment

### Downloads
Every file the browser downloads (a click on a link, a button, or `open` on a file's address) is saved
in a folder of the chat's own, `<state dir>/computer/downloads/<chat>/`, and is not deleted by ClikCode.
The tool result that follows the click or open says `Downloaded name.csv (8 B) at /path/name.csv`;
`downloads` lists the folder again. Names are made safe on every operating system (no folders, no
reserved characters, a clash becomes `name (1).ext`). The one exception is a key being captured with
`capture_secret`: that download is read and deleted, as before.

### Uploads
`upload` (a file input, or the button that opens the file chooser, plus `text`) sends either a file the
user saved in a profile under a name ending `_file` (`logo_file`), or an **absolute path** to a file in
the workspace or in this chat's downloads folder. Anything else is refused with the reason: a path
outside those two folders (symlinks are followed, so a link that points out is refused), a dotfile or
file inside a dot folder (`.env`, `.git`, `~/.ssh`, `~/.aws`), ClikCode's own state, another chat's
downloads, private keys and credential files (`id_rsa`, `*.pem`, `*.key`, `credentials`), a
directory, or a file over 50 MB. The approval prompt shows the path being sent; permission rules for
paths apply to it.

### Dialogs
A page's `alert`, `confirm`, `prompt` and "leave this page?" (`beforeunload`) boxes are watched for the
whole life of the tab, not only during a click. Nothing is silently lost, and the safe answer is the default:
- During a **click** (or a step), a box is declined and the result says what was asked
  (`confirm: "Delete this token?" (declined)`); click again with `accept_dialog: true` to accept.
- A box that arrives **at any other time** (a timer, Enter in a form, a page reaction) is **held**: the
  page waits, the next result shows the question, and every other action answers with it until the
  agent replies with `dialog`: `accept_dialog: true` accepts (for a `prompt`, `text` is the answer),
  leaving it out dismisses. A held box nobody answers is dismissed after two minutes.
- An `alert` has one button, so it is closed at once and mentioned in the next result.
- `open` accepts a "leave this page?" box, since leaving was the request.
- During actions that do not expect one (a sign-in, a key capture) a box is dismissed and reported.

The process that owns Chrome also listens, so it does not dismiss a box before the worker's answer
arrives (before this, an accepted confirm could still come out as "cancel").

### HTTP sign-in (the browser's own username/password box)
A site behind HTTP Basic or Digest authentication (a 401 with `WWW-Authenticate`) shows the browser's
own box, which no page action can fill. `open` with `http_auth: true` (or `http_auth: "<username or
email>"` to choose between saved logins), or `auth` (`url` = the site, default the open page, then it
reloads), answers the challenge from the **saved login for that origin** in the encrypted vault. With no
saved login the user is asked once, privately, and it is kept. It works through the DevTools protocol
(`Fetch.authRequired`), because Playwright's `httpCredentials` cannot be set on a browser that is
already running. The credentials are used for that origin only, never for a proxy, sent once per request
(a wrong password is not retried in a loop), and never appear in a result. https sites only, like the
vault. `auth` with `clear: true` turns it off for the tab.

### Site permissions (camera, microphone, location, notifications, clipboard)
By default every one is **denied** for every origin, set before a page is opened, so no permission bubble
appears and blocks the page. `permissions` with `grant: ["geolocation", "clipboard"]` (names: `camera`,
`microphone`, `geolocation`, `notifications`, `clipboard`) allows them for one origin (`url`, default the
open page; https or localhost only), `deny` takes them back, and with neither it lists the state. It uses
the DevTools `Browser.setPermission` per origin (Playwright's `grantPermissions` resets every other
permission of the context, which would undo the rest). Chrome forgets a decision when the connection that
made it closes, so it lasts while the session runs; the next `open` denies again whatever is undecided.

### PDFs and other documents
When a tab lands on a PDF, `open` and `observe` return its **text with page markers**
(`--- page 3 of 40 ---`), capped at about 30,000 characters; `observe` with `pages: "11-15"` (or
`"2"`, `"1,4-6"`) reads other pages, and the result says how many are left. The file is fetched again
through the tab's own request context, so a PDF behind a sign-in works, then read with pdf.js (the
`unpdf` package, loaded only when a PDF is opened; this is the one runtime dependency this feature adds).
A scan with no text layer says so. A plain-text, JSON, XML or CSV tab returns its text; an image or any
other document says what it is. Text that looks like a key is hidden, as on any page.

### Headless, no display, and no Chrome
- **Window or not.** `CLIKCODE_BROWSER_HEADLESS=1` (or `clikcode computer headless on`) runs the browser with
  no window on any system (`=0` forces a window). On Linux with no `DISPLAY` or `WAYLAND_DISPLAY` and no
  `xvfb-run` (a server, a container, ssh) it falls back to headless by itself instead of failing; with
  `xvfb-run` it still uses a virtual display. macOS and Windows behave as before unless you ask.
- **No browser installed.** ClikCode uses Chrome, then Edge. If neither exists it uses Playwright's own
  Chromium if that is already downloaded, and otherwise downloads it once (`playwright-core install
  chromium`, a few hundred MB, the same on Linux, macOS and Windows). While it downloads, `open` answers with
  the progress ("Downloading Chromium ... 40% of 120 MiB, wait, then open the page again") instead of
  waiting; the download continues in the background. If it cannot (offline, no disk), the error says so in plain
  words with what to install, and a failed download is not retried for an hour. The detached browser process
  reports why it could not start through `computer/host-status.json`, so these messages reach the agent.

### Size, device, location, language, PDF and cookies
- **`viewport`** sets how the tab presents itself, over the DevTools `Emulation` domain: `width`, `height`,
  `scale` (device pixel ratio), `mobile` (mobile viewport and touch), or `device: "iPhone 15"` (any name in
  Playwright's device list, matched loosely: size, scale, user agent and touch together); `geolocation`
  (`{latitude, longitude}` or `"48.85,2.35"`; a site can read it once `permissions` grants `geolocation`),
  `timezone` (`Europe/Paris`) and `locale` (`fr-FR`, JavaScript and `Accept-Language`). `reset: true` undoes
  it all; with nothing given it says what is in force. Chrome drops emulation when the connection that set it
  closes, so it lasts while the tab and the session do; reload for a new user agent or language to reach the site.
- **`pdf`** prints the page to a PDF in the chat's downloads folder (`landscape`, `file_name`; the name defaults
  to the page title) with the DevTools `Page.printToPDF`, and reports the path and size. It works in a window
  and headless; a Chrome too old to print says so.
- **`cookies`** lists the current site's cookies by name, domain, path and expiry, with `httpOnly`, `secure` and
  `SameSite` flags, **never the values**; `clear: true` removes them for the site (`url` names another site).
  There is no cookie import: ClikCode's browser never takes cookies from the user's own profile.

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
send_to: { to: "clikdeploy-connection", with: { integration: "algolia" }, connectionValues: { app_id: "WJUQDEJ3SG" } }  // base URL needs a per-account value
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
`send_secret` (an action of `browser_use`) sends a saved key again, or somewhere else, with `{secret, to, with}`.

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

## Desktop control (`computer_use`)

### Installing cua-driver

`clikcode computer driver install` downloads the newest cua-driver for this OS and CPU from its GitHub release
download URLs, so it does not touch the GitHub API (whose unauthenticated limit made Cua's own updater fail). The
newest version comes from `gh` when it is signed in, else from the version named by Cua's published installer plus a
probe for newer release assets. The archive must match the release's published checksum, and its Sigstore signature is
verified when `cosign` is installed. It is unpacked to `~/.cua-driver/packages/releases/<version>-<target>/`, the
`current` link is switched atomically (a directory junction on Windows), and the previous release stays on disk.

| Command | What it does |
|---|---|
| `clikcode computer driver status [--offline]` | The installed version and path, the releases on disk, the newest release, and whether this desktop needs a newer one. |
| `clikcode computer driver install [--version x.y.z] [--force]` | Install (the newest, or an exact version). Never downgrades without `--version`. |
| `clikcode computer driver update` | Same as install of the newest; says so when already current. |
| `clikcode computer driver rollback` | Switch back to the release that was active before the last install. |
| `clikcode computer driver wayland-helper [--yes]` | Run Cua's bundled GNOME Shell helper installer, on GNOME 45-49 only (refused on 50 and newer, where Cua turned it off because it crashed the Shell). Without `--yes` it only explains. It asks for one log-out. Nothing runs it automatically. |

On macOS, Cua's own installer places the signed app in `/Applications` (the macOS permission identity depends on that
path), so `install` runs it pinned to the version found here; a pinned install makes no API call either. ClikCode finds
`cua-driver` on `PATH`, else in `~/.cua-driver/packages/current/`, else in the macOS app, so `PATH` need not be set.
When `cua-driver` is missing, `computer_use` says to run `clikcode computer driver install`; when the installed one is too
old for a Wayland desktop it says `clikcode computer driver update`.

### Actions

| Action | Needs | Notes |
|---|---|---|
| `windows`, `apps` | | `apps` lists graphical apps (running ones with a visible window); `query` also searches installed apps. |
| `observe` | | Desktop screenshot, or a window's accessibility tree (a 10 second walk budget and 1500 elements when cua-driver supports `timeout_ms`, so big Electron apps such as VS Code are not cut off at Cua's 1 second default). |
| `click`, `double_click`, `right_click` | `element_token` or `x`,`y` | A window uses Cua's tools of the same name; the desktop uses `click` with a count or button. |
| `drag` | `x`,`y` to `to_x`,`to_y` | |
| `type`, `key`, `hotkey`, `scroll` | | |
| `zoom` | window, `x`,`y` to `to_x`,`to_y` | A closer picture of part of a window; needs a model that can see images. |
| `launch_app` | `app` and/or `urls` | By name (macOS: bundle id; Windows: name or package id with `!`). No paths, no flags; urls are http(s) only. |
| `bring_to_front` | window | Leaves the window in front, which takes focus. |
| `invoke_menu` | window, `path` | An exact menu path through accessibility, no pixels. |
| `set_window_frame` | window, `x`,`y`,`width`,`height` | |
| `screen_size` | | |
| `clipboard_read`, `clipboard_write` | | Reading is private: only when the user asked to use what they copied; text passes secret scrubbing (key- and token-shaped text is hidden). |

Not offered on purpose: `kill_app` (too destructive; closing is done through the app's own UI) and `mouse_button_down/up`
(X11 only; `drag` covers it).

**Foreground delivery.** Every input action runs in the background and leaves the user's focus alone. When Cua refuses
because the window must be in front, the tool says so and the model may retry that one action with `delivery: "foreground"`,
which briefly takes focus and puts it back. It is a per-call argument only, never a default, and the description
tells the model to use it only when the user can spare the focus.

### What each OS can do

"Verified" means exercised on a real machine in this repository's development; "docs" means taken from Cua's published
guides (`libs/cua-driver/rust/Skills/cua-driver/*.md`) and tool schemas (`cua-driver describe <tool>`), not run.

| | Linux (GNOME Wayland) | Linux (X11) | macOS | Windows |
|---|---|---|---|---|
| Install command | verified (real downloads, checksum, flip, rollback) | same code path, not run | Cua's installer, pinned: not run (no cua-driver on the Macs available; both reachable, one macOS 15.7 and one 10.15) | layout and junction code from install.ps1: unit tests only, no Windows machine |
| `windows`, `apps`, `screen_size` | verified (AT-SPI; cua-driver 0.38) | docs | docs | docs |
| `observe` (tree, `timeout_ms`) | verified; window screenshots may be missing on Wayland | docs | docs | docs |
| click / type by `element_token` | verified | docs | docs | docs |
| double_click, right_click, drag by element or pixels | refused in the background on GNOME 50 Wayland (verified); needs foreground, which GNOME 50 also refuses | docs: background works (XI2 virtual pointer) | docs: background works (SkyLight per pid); macOS drag-and-drop sessions need foreground | docs: UIA invoke, else synthetic events; occluded targets need foreground |
| key, hotkey, scroll | needs foreground on Wayland (verified refused); GNOME 45-49 with Cua's helper may allow it (docs) | docs: background | docs: background | docs: background for plain Win32; Chromium, GTK, VCL need foreground |
| `delivery: "foreground"` | refused on GNOME 50 (verified: `foreground_unavailable`) | docs | docs | docs; needs UIAccess to reliably take focus |
| `launch_app` | verified (`gnome-calculator`) | docs | docs (`bundle_id`, `urls`) | docs (`aumid`, `path`, `name`) |
| `bring_to_front`, `invoke_menu` | refused on GNOME 50 (verified, needs activation) | docs | docs | docs |
| `set_window_frame` | refused on Wayland by design (verified); EWMH on X11 (docs) | docs | docs | docs |
| `zoom` | needs a window screenshot | docs | docs | docs |
| `clipboard_read` / `clipboard_write` | verified | docs | docs | docs |
| Permissions | none beyond the accessibility bus (`org.a11y.Bus`) | none | **Accessibility** and **Screen Recording** for `com.trycua.driver`; missing ones are reported with the fix | none for normal use; **elevated (administrator) windows cannot be driven** from a non-elevated process; session 0 has no desktop |

On macOS a missing grant is detected from `cua-driver permissions status --json` (shown on `windows`) and from Cua's
error text, and the model is told to ask the user to grant it (`cua-driver permissions grant`, then System Settings >
Privacy & Security). Without Screen Recording the accessibility tree still works, so element actions continue. On
Windows an access-denied or elevated-window refusal is explained as the administrator-window limit, and a session 0
daemon is reported with `schtasks /Run /TN cua-driver-serve`.

The password guard is unchanged in scope and works the same on every OS: a screenshot (`observe`, `zoom`) is refused only
when a typed password, code or card number is on screen in the ClikCode browser, and a window screenshot of any other
process is allowed. The browser's own process ids come from Chrome (`SystemInfo.getProcessInfo`) and are compared with
the window owner's process id from `list_windows`, which is the OS process id on Linux, macOS and Windows alike; a
window with no pid is guarded as if it were the browser.

## Limits

- Some sites refuse automated browsers whatever is done.
- A key shown only as an image, or split across boxes, or sent only by email: use the
  paste prompt or `handoff`.
- The key is briefly in the `clikdeploy` command line, visible to the same OS user.
- A URL change is the only success signal for a sign-in; no site-independent proof
  exists.
- `computer_use observe` is refused while a browser tab holds a typed password, code or
  card number, since a screenshot would show it. Acting is allowed.

## Doing a long run of sign-ups and app registrations

What the browser tool does so a run does not depend on luck or on the user:

- **Waits report state.** A `wait` whose words do not appear is the page's answer, not a failed tool: the
  batch stops there, says how many later steps did not run, and shows what changed. A tab that closes
  itself (a sign-in popup) is read from the page's own state and the batch carries on from the tab left.
- **Calls run in order.** Two `browser_use` calls made together run one after the other, so a capture
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

- **Generated site passwords (on by default).** Like a phone's "Strong Password": when `browser_use` fills a sign-up or
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
(`clikdeploy-connection-basic` for username + password), then test and publish. Those two destinations read the result back from ClikDeploy (`clikdeploy integrations show <id>`) and answer one line, never empty (also through `clikcode computer store`): `connected`, or `NOT connected: <reason>`; the read-back tolerates warnings printed around the JSON; a command that printed success while nothing was stored is reported as not connected, and the key is never in the line. Captcha, SMS, payment, attestation and phone-approval
steps go to the queue (`queue`) and the loop moves on. ClikDeploy never browses; ClikCode never touches a spec's internals beyond the
schema ClikDeploy serves (`connector_spec_guide`).

## Connecting a connector's OAuth: `oauth_connect`

`clikcode computer oauth-connect <connector>` (or `browser_use` `action=oauth_connect`, `target` = the ClikDeploy connector id) connects a connector that uses OAuth, with no clicking by the agent:

1. It starts ClikDeploy's connect (`clikdeploy integrations connect <id> --no-browser`, which signs in with the saved admin key) and takes the authorization URL it prints.
2. It opens that URL in the ClikCode browser and presses through the consent screens from a data table in `src/agent/computer/oauth-consent.ts` (add a row to teach it a screen): the account named by the profile `sso_email`; Google's "Advanced" and "Go to ... (unsafe)", Continue/Allow; Microsoft Accept; GitHub "Authorize ..."; Slack Allow; Atlassian Accept; Notion Allow access; and for any other vendor Allow, Authorize, Accept, Grant access, Approve (and Continue only on a page that asks for access). It never presses Deny, Cancel, Sign out or Sign up.
3. It returns when ClikDeploy's callback page is reached, and then confirms with `clikdeploy integrations show` that the connection is `active`. The vendor's word is not enough.

It never types or reads a password. It stops, with a plain reason (the address and the names of what can be pressed, no page text or values) at a **login password**, an **MFA code**, a **captcha**, or a screen it does not recognize. If the vendor needs a sign-in, run the `login` action first (saved login or Google), then run `oauth_connect` again. Opt-in smoke test against a fake multi-screen vendor and a fake connect endpoint: `CLIKCODE_COMPUTER_SMOKE=1 xvfb-run -a npx vitest run src/agent/computer/oauth-consent.integration.vitest.test.ts`.

## Recipes record themselves

Agents rarely call `recipe save`, so ClikCode does it. Every successful `browser_use` click, fill, choice and key press after an `open` is journaled in memory for that tab, by the control's visible text (a `[ref=eN]` is turned into the control's name). When the sequence ends in a **verified** `capture_secret` (a key was found and stored, not rejected by its check) or a successful `login`, the journal is saved as that host's recipe (`~/.clikcode/computer/recipes/<host>.json`) with the login route (`google` or `github` if the sequence passed through them, else `email`), the key page (address without query or fragment) and a capture hint. Nothing else is needed from the agent.

- **Never stored:** typed values (a fill is saved with no text, so a replay fills from the profile or saved login), secrets, ids or numbers of six digits or more in a control name, anything key-shaped. An email in a control name (the Google account chooser) is saved as the placeholder `{{sso_email}}` and replaced from the profile at replay. A step that cannot be saved safely (a reference with no readable name, a control named after an id) spoils that journal, so a partial recipe is never saved.
- **De-duplicated:** one recipe per host and route, the newest verified one wins. A plain login recipe never replaces a capture recipe that has a key page and hint.
- **Used:** opening a page on that host says "A recipe is saved for this site"; `recipe` with `recipe_op=run` replays it and stops at a captcha, code, payment or review page. Replays are not journaled again.

## Preflight: is this computer ready for onboarding work

`clikcode computer preflight` (or `browser_use` `action=preflight`) is one deterministic check with no agent in it, for an agent to run before a batch and for a scheduled check. It prints JSON and exits 1 when anything is not ready:

- `browserOk`: ClikCode's Chrome starts and opens a tab.
- `googleSignedIn`: `accounts.google.com`, opened in a throwaway tab, ends on the account page (signed in) and not on the sign-in form or account chooser. Only the page address and whether an email box exists are looked at.
- `gmailReadable`: Gmail's inbox view renders for the profile's sign-in account (so `read_email_code` and `open_email_link` can work).
- `buildId`: the commit of the running build (else `<version>-nocommit`).
- `depsLinkOk`: the installed release's `node_modules` link (`~/.local/share/clikcode/release`, or `CLIKCODE_RELEASE_DIR`) resolves `playwright-core` and `yaml` and is not inside the temp folder. A link into `/tmp` breaks the installed CLI at the next cleanup or reboot; reinstall with `node scripts/install-local.mjs` from a checkout with its own `node_modules`.
- `ok` is all four checks; `reasons` has one line per failure.

It then looks for a `connector_preflight` tool in ClikDeploy (`clikdeploy tools search connector_preflight`) and posts the result there when it exists. `clikdeploy` in the JSON says `posted` or why not (for example "ClikDeploy has no connector_preflight tool yet"); a missing tool never fails the check. `--no-post` skips it.

## Profiles: which one a form is filled from

With no `label`, the profile used is the one called `Personal`, else the one with the most standard fields (name, email, phone, address, ...). It is never "the first by name", so a second profile such as `ClikDeploy admin` is only used when a call names it with `label`, or when it can fill more of the form's fields than Personal (`bestProfileFor`). Saving with no label merges into that same profile instead of creating another.

## Choosing a key's scope

When a vendor offers a choice when creating a key (scopes, permissions, "restricted" and "unrestricted" keys):

1. Ask ClikDeploy what the connector needs. Its `connector_scope_check` tool (find it with `clikdeploy tools search connector_scope_check`; it may not exist yet) answers which scopes or permissions the connector's operations require. If it does not exist, read the operations in the connector spec (`connector_spec_get`) and the vendor's reference for which permission each one needs.
2. Pick the least-privilege key that covers every operation the connector exposes (read-only scopes when the operations are reads; add a write scope only for the operations that write). Name the key for what it is for (`clikdeploy <integration>`), set no expiry the vendor does not require, and restrict by IP or resource only when the vendor allows it without breaking ClikDeploy's calls.
3. Choose the unrestricted key only when the vendor offers no scopes, when scoped keys cannot call an operation the spec lists (say which in a `notes` entry), or when `connector_scope_check` says the full scope is required. Record the choice and why in the site's notes and the queue task note.
4. Never widen a key to make a test pass without recording it; a connector that needs more than it declared is a spec problem to report, not a reason to take every permission.

## Worker notes and where progress is kept

Durable notes go under `~/.clikcode`, never `/tmp` (a cleanup or reboot loses `/tmp`, and a restarted agent then repeats the work).

- **Per-site notes** (what worked on a vendor's site: URL, order of screens, gotchas): `browser_use` `action=notes` with `host` and `note` saves one (newest last, 4,000 characters kept; a note shaped like a key or token is refused whole); with only `host` it reads them back. They are kept in `~/.clikcode/computer/notes/<host>.md` and are shown again when a page on that host is opened. The call needs an open tab (`open` a URL first). From a shell: `clikcode computer tool browser_use --args-json '{"action":"notes","host":"app.example.com","note":"API keys: Settings > Developer > New key"}'`.
- **Run progress** (which vendors are done, what is next): record each outcome in the queue (`browser_use` `action=queue`, `clikcode computer queue`), which is the durable list to resume from. Anything more free-form goes in a file under `~/.clikcode/computer/progress/`, one per run, appended to as work happens. Never put a key, password or code in either.

## Email: a connected mailbox

`clikcode computer email connect` (or the browser tool action `email_connect`) opens Google's consent for **read-only mail** in the ClikCode browser, which is already signed in, chooses the profile's `sso_email` account, presses through Continue/Allow, and stores the refresh token in Secrets Manager as `email/gmail`. Nothing else to do and nothing printed but "Mailbox connected: <address>". `status` shows which mailbox; `disconnect` forgets it.

From then on `read_email_code` and `open_email_link` read the mail through the Gmail API and **wait for it to arrive** (`seconds`, default 90), instead of looking once in a browser inbox. They return only the code or open the link; the token is read inside the worker and never appears in a result. With no mailbox connected they use the browser inbox as before.

The consent needs a Google OAuth **Desktop** client: save it as the secrets `email/google-client-id` and `email/google-client-secret` (capture_secret from the console's Copy buttons; or one JSON secret `email/google-client`) or set `CLIKCODE_GOOGLE_CLIENT_ID` / `CLIKCODE_GOOGLE_CLIENT_SECRET`. An app left in Google's *testing* mode has its refresh token expire after 7 days (a later call then says to reconnect); the ClikDeploy project is in production, so it does not, and consent shows Google's "unverified app" notice, which `email connect` presses through (100 consents allowed before verification).

### Emailed codes and links fill themselves

With a mailbox connected, a one-time-code box that `login` or `fill` (no text) meets is filled from the email, with no agent call. The right email is found by checks, not by guessing:

1. The sender must belong to the page's site (sender domain or name, then the subject, then the start of the body).
2. It must have arrived after the page asked, and read like a verification message (a newsletter holding a number is refused).
3. Each email is taken once: the ids already handed out are kept in `computer/email-consumed.json`, so two agents never get the same message.
4. Two different senders that both fit are not chosen between: the step is held.
5. The inbox is read first, then spam, over three passes of 30 seconds. If nothing comes, the signup is recorded in the queue as `needs-human` with reason `email` and the step stops, so the run goes on to the next vendor; `clikcode computer queue --reason email` lists them.

`read_email_code` and `open_email_link` with no `from` or `subject` use the same rules for the page they are on. With `from` or `subject` they read the newest matching message, as before. With no mailbox connected nothing changes: the code is asked for privately.
