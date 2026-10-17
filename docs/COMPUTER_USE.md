# Computer use and ClikCode Secrets Manager

ClikCode's own agent can use a persistent Chrome browser through Playwright and
the primary desktop through Cua Driver. Computer use is available by default.
The agent opens a URL in one action when it needs a browser, and can close it
when done. `/computer off` or `clikcode computer off` stops new actions and
closes the browser; `on` makes it available again.

The browser uses its own profile under ClikCode's state directory. A detached
browser host keeps that profile open, and terminal and VS Code workers attach
to the same browser. It does not attach to a personal Chrome profile. Existing
sign-ins in that profile remain available across turns.
The visible Chrome session suppresses its standard WebDriver page signal.
Some websites can still reject automated sign-ins; no browser setting can
guarantee access to every site.

On a sign-in page the agent sees the visible field labels and types, never
their values or a screenshot. `computer_web login` reuses saved fields or asks
for exactly the fields visible in the ClikCode terminal or VS Code panel.
One action follows ordinary email-first and password pages. New answers are
saved only after a password is submitted and the browser moves past the
sign-in page. A rejected or unverified attempt leaves no new saved login.
The values go directly from the UI to the local worker and ClikCode Secrets
Manager; the model receives only the status.

Saved accounts: with one login saved for a site, `login` simply uses it. With
several, the terminal or VS Code panel shows a picker of their usernames or
emails (arrow keys and Enter), plus "Use a different account". Passing
`new_account` (tool), `--new` (command) or `/computer login --new` skips the
saved account. If a site refuses a saved password, the picker appears next
time so an updated one can be entered; typing the same username again updates
that account instead of adding a copy. The picker is shown to you only: the
model never sees the usernames, and your choice is not written to the chat
history. When a sign-in page offers different ways in (root or IAM, another
account), the page observation lists them by name and the agent asks you with
`ask_user` before clicking.

One-time codes: a verification-code box (authenticator, SMS, email) is asked
for in the same private prompt every time it appears. The code is typed
visibly, filled, and never saved. Two wrong codes stop the attempt rather
than guessing a third time, and a page with the code split across several
boxes is handed to `handoff`. Waiting on a phone approval or CAPTCHA lasts up
to ten minutes, as long as a private prompt does, and the new login is saved
only if sign-in then completes.

Managing saved logins: `/computer logins` (or `clikcode computer logins`)
lists every saved login as `site · username` in the same picker, lets you
remove one after a confirmation, and reports only a count. The usernames are
shown to you, not to the model or the command's output, and nothing about
them is written to the chat history or the worker's record.

Matching: a login belongs to a site by its host. The one looseness is a
leading cloud-region label, so a login saved on `us-east-2.signin.aws.amazon.com`
also works on `eu-west-1.signin.aws.amazon.com`. Other hosts must match
exactly, and a failed sign-in explains itself in plain words (no form visible,
several password fields, wrong code, site refused the saved password) without
quoting the page. ClikCode generates a random
32-byte encryption key automatically on first use. It stores that key in a private
local file (`computer/vault/vault.key`, mode 0600), and encrypts each saved login
with AES-256-GCM in a separate file. No setup or vault password is required.
Passwords are masked in the terminal and panel. Email, phone, and account IDs
are visible while typing. All login answers are omitted from the transcript
and agent context. No ClikDeploy or Tailscale account is needed
to enter them.

The login action fills and submits the same HTTPS origin. It reads the key and
decrypts the item inside the worker, including after the worker restarts. The
agent can inspect field names on login pages, while page values and screenshots
stay private. A URL change is a completion signal, not proof that every website
accepted the login. If a site uses an unfamiliar or cross-origin login, the
user can finish through `computer_web handoff` instead.

For CAPTCHA, MFA, or another step the agent cannot finish, `computer_web handoff`
provides a one-use, ten-minute phone link. The user opens it, completes the
step in the same live browser, then taps Done. ClikCode starts Tailcat for this
handoff and closes it afterward. The phone connects over Tailcat's encrypted
transport; the browser version currently uses a DERP relay for its traffic.
The Tailcat address and a second random session token stay in the URL fragment,
which is not sent to the static page host. No ClikDeploy or Tailscale account is
needed for this handoff. ClikCode downloads and verifies the Tailcat binary on
first use on Linux and Windows. On macOS it installs Tailcat through an existing
Homebrew installation. The phone needs a
modern browser with WebAssembly and DecompressionStream support.

ClikCode Secrets Manager is the built-in source for saved website logins.

The local key file is private to the OS account, but it is not an isolation
boundary against other processes running as that same user. ClikCode's shell
and desktop tools also run as that user. A separate OS identity and broker
would be required to prevent those tools from accessing the key or a signed-in
website. The shared browser host exposes a Chrome debugging port on loopback;
other processes on the same computer could connect to it. Use a dedicated OS
account if untrusted local users share the computer. Sites may show an account
email or ID after login.

In any harness chat, `/computer inspect` shows safe login field names and
`/computer login [url]` opens the private prompt. Harnesses that can execute
local commands can call `clikcode computer inspect` and `clikcode computer login
[url]` themselves. Vendor harnesses do not automatically receive ClikCode's
own `computer_web` tool; the shared slash commands work regardless of route.
