# Computer use

ClikCode's agent can drive a browser of its own and the rest of the desktop. Both
are on by default; `/computer off` (or `clikcode computer off`) refuses new actions
and closes the browser, `on` brings them back.

| Tool | What it is for |
|---|---|
| `computer_web` | A Chrome with its own saved profile (Edge if Chrome is missing), shared by every terminal and VS Code window, never your personal profile. **Each chat gets its own tab**: a chat only sees, acts on and follows tabs it opened itself, so chats working at once do not collide. `close` closes that chat's tab only. |
| `computer_desktop` | Everything outside the page, through [cua-driver](https://github.com/trycua/cua) (a separate install): a popup window, a native dialog, another app. Give it a `pid` and `window_id` from `windows` to act on one window. |
| `store_secret` | Send a key already in Secrets Manager on to a destination again. Values are never shown. |

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
- A CAPTCHA, or MFA that needs hands: `handoff` returns a one-use phone link at once (static
  page `site/handoff/` on `gh-pages`, an encrypted Tailcat connection, no ClikDeploy or
  Tailscale account); the agent gives it to you, then calls `handoff` again to wait until you
  finish.
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
send_to: [ ...several of those... ]
```

Four ship as plain data (`clikdeploy-secret`, `clikdeploy-app-secret`,
`clikdeploy-compute`, `github-secret`). You add your own with one line, and the agent
can then use it by name; an unknown name is answered with the full list:

```
clikcode computer destination add my-vault --stdin "{{secret}}" -- vault kv put secret/{{path}} value=-
clikcode computer destination list | remove <name>
```

Only you can add one (the agent cannot), so what can ever run is decided by you, not
by a page the agent is reading. `{{secret|json}}` is the key inside a JSON string; a
destination's `--stdin` keeps the key out of the command line. Every result begins
`SAVED` or `Not saved:` and says what really happened, including a warning when a
click may have made the site create a key that was then not saved (delete it there).
`store_secret` takes the same thing as `{secret, to, with}`.

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
  `computer secrets [--delete NAME]` (your own vault, no chat needed), `computer login`.

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
