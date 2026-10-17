# Computer use

ClikCode's agent can drive a browser of its own and the rest of the desktop. Both
are on by default; `/computer off` (or `clikcode computer off`) refuses new actions
and closes the browser, `on` brings them back.

| Tool | What it is for |
|---|---|
| `computer_web` | A Chrome with its own saved profile (Edge if Chrome is missing): open, observe, click, fill, login, capture_secret, handoff. Shared by every terminal and VS Code window; never your personal profile. |
| `computer_desktop` | Everything outside the page, through [cua-driver](https://github.com/trycua/cua) (a separate install): a popup window, a native dialog, another app. Give it a `pid` and `window_id` from `windows` to act on one window. |
| `store_secret` | Send a key already in Secrets Manager on to a destination again. Values are never shown. |

Nothing here asks you anything of its own: in Auto mode these tools just run, and the
agent stops only for what it cannot do itself (a sign-in you must type, a choice
between accounts, a payment, a CAPTCHA).

## Signing in

`login` is one action. The agent sees field names, never values or screenshots of a
sign-in page; you type into a private prompt in the terminal or VS Code panel
(email shown, passwords masked, nothing recorded in the chat).

- One saved login for the site is used silently. Several: an arrow-key picker plus
  "Use a different account".
- Email-first, password and one-time-code pages are followed in turn; a code is
  asked for every time and never saved.
- A login is saved only after the browser leaves the sign-in page. A refused one
  is never saved, and a saved one a site refuses is asked about next time.
- `/computer login [url] [--new]` does it from the command line; `/computer logins`
  lists and removes saved logins (the model sees only a count).
- A CAPTCHA, or MFA that needs hands: `handoff` gives you a one-use phone link
  (static page `site/handoff/` on `gh-pages`, an encrypted Tailcat connection, no
  ClikDeploy or Tailscale account).

## Getting an API key without the agent seeing it

The agent signs in, sets the options, then makes one `capture_secret` call: the final
Create button, and `send_to`, saying where the key goes. Your request is the
authorization; there is no extra approval step.

1. **Find the key.** Press the site's own Copy button; or notice a file the click
   downloads (a service-account JSON); or recognise the key on the page. Only if
   none is clear does the private paste prompt appear.
2. **Check it.** The key is tried against its own service (Hugging Face, Google AI
   Studio, Together, OpenAI, Anthropic, Groq, Mistral, DeepSeek, OpenRouter), with
   a damaged copy as a control. A key the service refuses is **not saved**.
   Anything else is saved and marked "not checked", with the reason.
3. **Save** it to ClikCode Secrets Manager (always).
4. **Send** it on, as `send_to` says. If a destination fails the key stays saved.

**A destination is a name for a command, nothing more.** The command has `{{secret}}`
where the key goes and `{{slot}}` for anything the agent fills in:

```
send_to: [{ to: "clikdeploy-secret",  with: { key: "SALAD_API_KEY" } }]
send_to: [{ to: "clikdeploy-compute", with: { provider: "GCP", field: "serviceAccountJson" } }]
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
`SAVED` or `Not saved:` and says what really happened.

Once held, a key's exact value (and its base64, URL-encoded and JSON forms, and each
long field of a JSON file) is replaced with `[secret hidden]` in every tool result,
and a screenshot of a page showing it is withheld. With no Create button,
`capture_secret` takes the key a page already shows. The computer's shared clipboard
is never read.

## In every harness

The tools run in the chat's worker, so they work the same in any harness:

- **MCP, automatically.** `clikcode mcp-serve` is a built-in server named `clikcode`,
  handed to every ACP harness session (and to Codex as `-c mcp_servers.clikcode.*`)
  as it starts. Nothing is installed or written into a harness's config; it ships in
  every ClikCode install and follows `/computer off`. `clikcode mcp list` shows it.
- **CLI, for anything else.** `clikcode computer tool <name> --args-json …`,
  `computer capture <name> --click button:Create`,
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
- `computer_desktop observe` is refused while a browser tab is on a sign-in page, so
  the screen cannot show what the page withholds. Acting is allowed.
