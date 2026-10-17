# Computer use

ClikCode's own agent can use a persistent Chrome browser through Playwright and
the primary desktop through Cua Driver. Computer use is available by default.
The agent opens a URL in one action when it needs a browser, and can close it
when done. `/computer off` or `clikcode computer off` stops new actions and
closes the browser; `on` makes it available again.

The browser uses its own profile under ClikCode's state directory. A detached
browser host keeps that profile open, and terminal and VS Code workers attach
to the same browser. It does not attach to a personal Chrome profile. Existing
sign-ins in that profile remain available across turns.

For an HTTPS login, `computer_web login` reuses the site's sole saved login or
prompts for its account ID, email and password in the ClikCode terminal or VS
Code panel. These values go directly from the UI to the local worker and vault;
the model receives only the tool's completion status.
ClikCode generates a random
32-byte vault key automatically on first use. It stores that key in a private
local file (`computer/vault/vault.key`, mode 0600), and encrypts each saved login
with AES-256-GCM in a separate file. No setup or vault password is required.
The password and other login fields are hidden in the terminal and panel and
are omitted from the transcript. No ClikDeploy or Tailscale account is needed
to enter them.

The login action fills and submits the same HTTPS origin. It reads the key and
decrypts the item inside the worker, including after the worker restarts. The
browser page is hidden from model observations
while a login is being handled. If a site uses an unfamiliar or cross-origin
login, the user can finish through `computer_web handoff` instead.

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

The optional `computer_web autofill` action triggers an installed Bitwarden
browser extension. The default private credential path uses ClikCode's local
vault and does not require Bitwarden.

The local key file is private to the OS account, but it is not an isolation
boundary against other processes running as that same user. ClikCode's shell
and desktop tools also run as that user. A separate OS identity and broker
would be required to prevent those tools from accessing the key or a signed-in
website. The shared browser host exposes a Chrome debugging port on loopback;
other processes on the same computer could connect to it. Use a dedicated OS
account if untrusted local users share the computer. Sites may show an account
email or ID after login.

Vendor harnesses do not automatically receive ClikCode's own computer tools.
The computer controls are available to ClikCode's own agent in the terminal
and VS Code.
