# Computer use

ClikCode's own agent can open web pages in a persistent Chrome and, separately,
control the desktop. Both are on by default. `/computer off` (or
`clikcode computer off`) refuses new actions and closes the browser; `on`
turns them back on.

## Two tools

- **`computer_web`** — a browser of its own: open, observe, click, fill, press,
  scroll, login, handoff, close. Chrome starts on the first `open`; Edge is used
  when Chrome is not installed. The profile lives under ClikCode's state
  directory, is shared by every terminal and VS Code window, and keeps sign-ins
  between turns. It never attaches to a personal profile.
- **`computer_desktop`** — the rest of the screen, through
  [cua-driver](https://github.com/trycua/cua) (a separate install; the tool says
  so if it is missing). With no window it acts on the primary desktop by
  screenshot coordinates. With a `pid` and `window_id` from its `windows` action
  it acts on that one window. Use it for what a page cannot reach: a popup
  window, a native permission or file dialog, another app.

In Auto mode `computer_web open` asks once for each new site. "Always" adds the
same `WebFetch(domain:…)` rule that `web_fetch` uses. Acting on a page that is
already open, and signing in, ask nothing more.

## Signing in

On a sign-in page the agent sees field labels and types, never their values and
never a screenshot. `computer_web login` does the rest in one action:

- It reads the visible fields (also inside an iframe), asks for exactly those in
  a private prompt in the terminal or the VS Code panel, fills them and submits
  with Enter, or the submit button if Enter did nothing. It follows email-first
  pages, then password, then code.
- Email, phone and account ID are shown while typing; passwords are masked.
  Answers never reach the model, the transcript or the worker's record.
- One saved account for the site is used without asking. Several: a picker
  (arrow keys, Enter) plus "Use a different account". `new_account` / `--new`
  skips the saved one. A site that refused the saved password asks again next
  time instead of resending it.
- A page that offers different ways in (root or IAM, another account) lists them
  by name; the agent asks you with `ask_user` before clicking.
- One-time codes are asked for every time and never saved. Two wrong codes stop
  the attempt.
- A new login is saved only after a password was submitted and the browser left
  the sign-in page. A rejected or unconfirmed attempt saves nothing.

`/computer login [url] [--new]` does the same from the command line, and
`/computer logins` lists saved logins as `site · username` so you can remove
one; the model sees only a count.

## In every harness

The tools are not tied to ClikCode's own agent. They run in the chat's worker,
and a harness reaches them two ways:

- **MCP, automatically.** `clikcode mcp-serve` is a built-in MCP server named
  `clikcode` (tools `computer_web`, `computer_desktop`, `store_secret`, `list_secrets`,
  `delete_secret`). It is handed to every ACP harness session as that session
  starts, and to Codex as `-c mcp_servers.clikcode.*` launch overrides, nothing is
  installed or written into the harness's config, and it ships in every ClikCode
  install, including the VS Code extension's own copy. It follows
  `/computer off`, and a server you record under the same name replaces it.
  `clikcode mcp list` shows it.
- **CLI, for anything else.** `clikcode computer tool <name> --args-json …`
  runs any of them; `computer capture <secret-name> --click button:Create` and
  `computer store <secret-name> --key SALAD_API_KEY` are the short forms;
  `computer login` and `computer inspect` already existed.

Either way the private prompts appear in the chat's terminal or VS Code panel
(so a chat window must be open), `store_secret` asks you to approve in that
window even if the harness would not, and results are scrubbed in the worker
before the harness sees them. A harness's own approval prompts still apply to
its MCP calls; ClikCode adds no second prompt for opening a page, only for
writes (`store_secret`, `delete_secret`).

## ClikCode Secrets Manager

Saved logins live in `~/.clikcode/computer/vault/`: a random 32-byte key
(`vault.key`, owner-only) and one AES-256-GCM file per login. No setup or
password. A login belongs to a site by host; the one allowance is a leading
cloud-region label (`us-east-2.signin.aws.amazon.com` matches `eu-west-1.…`).

The key sits beside the files, so it protects against a copied folder, not
against other processes running as you. ClikCode's shell and desktop tools run
as you too, and the browser host listens for local debugging on loopback. Use a
separate OS account if untrusted users share the machine.

## API keys the agent never sees

To get a key from a site into ClikDeploy without the model reading it, the agent
signs in, sets the permissions, then calls `computer_web capture_secret` with a
`secret_name` and the role and name of the final Create button.

- **The worker finds the key itself.** After the Create click it presses the
  site's own Copy button (named "Copy", "Copy key", "Copy token"; a "Copy cURL" or
  "Copy project name" button does not match) and takes what the page copies: that
  is the key by definition, even when the page only shows dots. Failing that, it
  records the page before the click and looks at what the site's own request returned and what new key-shaped text
  appeared. A value counts when it is new on the page, or returned under a
  credential-named field (`api_key`, `secret`, `access_token`; a plain `token`
  such as a CSRF token does not count). One clear leader is saved to ClikCode
  Secrets Manager. The agent hears only the name and the length.
- **It is tested before it is saved.** The value goes to the issuing service's own
  API (chosen by the page's host: Hugging Face, Google AI Studio, Together AI,
  OpenAI, Anthropic, Groq, Mistral, DeepSeek, OpenRouter) together with a damaged
  copy as a control. A key the service refuses is not saved (it was an id or a page
  blob), and a service that answers both the same is reported as "not verified".
  Sites without a check are saved as "not verified" and say so.
- **Only when unclear does a person help:** two equally likely keys, or none
  found. The private prompt then appears (masked, never in history), and the
  page's own Copy button or a keyboard copy on that page also completes it.
  `remote` prints the phone link for tapping Copy. The computer's shared
  clipboard is never read, so an unrelated copy cannot be taken for the key.
- **`store_secret`** sends it on. The agent names the saved secret and the
  destination key (`SALAD_API_KEY`); the worker runs the CLI itself, so the value
  is in no command the model writes. Each use asks for approval. Destinations:
  a ClikDeploy platform secret, a ClikDeploy app secret (`app`), or a GitHub
  repository secret (`destination: github`, `repo: owner/name`; the value goes to
  `gh` on stdin). What ClikDeploy answers (set, applied to the running process) is
  relayed as it is; testing and running the platform are ClikDeploy's own tools.
  
  `clikdeploy tools run admin_platform_secrets` lists every platform key with the
  page where its key is created, which is the list of what to fetch.
- **`list_secrets`** and **`delete_secret`** show names only and remove one by
  name (re-capturing a name replaces its value). From a shell:
  `clikcode computer secrets [--delete NAME]`.
- **Scrubbing.** Once held, a secret's exact value (and its base64, URL-encoded
  and JSON-escaped forms) is replaced with `[secret hidden]` in every tool result
  and streamed output, and a screenshot of a page that shows it is withheld.

Limits: a key shown as an image or QR, split across boxes, only in a downloaded
file, or only after an email confirmation is not found on its own. The value is
briefly in the `clikdeploy` command line, visible to other processes of the same
OS user.

## Stuck steps: phone handoff

For a CAPTCHA or MFA the agent cannot finish, `computer_web handoff` prints a
one-use ten-minute link. Open it on a phone, finish the step in the live
browser, tap Done. The page is static (`site/handoff/`, published to the `gh-pages` branch) and talks
to your computer over an encrypted Tailcat
connection; the token stays in the URL fragment, so the page host never sees it.
No ClikDeploy or Tailscale account is needed. The Tailcat binary is downloaded
and checksum-verified on first use (Homebrew on macOS). The phone needs
WebAssembly.

## Limits

- Some sites reject automated sign-ins regardless of the browser's settings.
- A URL change is the success signal; no site-independent proof exists.
- Desktop tools are refused while any ClikCode browser tab is on a sign-in page,
  so the screen cannot expose what the page withholds from the model.
- A code split across several boxes goes to `handoff`.
