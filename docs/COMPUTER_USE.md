# Computer use

ClikCode's own agent can use a persistent Chrome browser through Playwright and
the primary desktop through Cua Driver. Computer use is available by default.
The agent opens a URL in one action when it needs a browser, and can close it
when done. `/computer off` or `clikcode computer off` stops new actions and
closes the browser; `on` makes it available again.

The browser uses its own profile under ClikCode's state directory. It does not
attach to a personal Chrome profile. Existing sign-ins in that profile remain
available across turns.

For an HTTPS login, `computer_credentials request` gives the user a private
form for the site's account ID, email and password. ClikCode generates a random
32-byte vault key automatically on first use. It stores that key in a private
local file (`computer/vault/vault.key`, mode 0600), and encrypts each saved login
with AES-256-GCM in a separate file. No setup or vault password is required.
The private form sends an encrypted packet to the local worker through the
ClikDeploy relay. The relay only holds ciphertext. The agent receives an
opaque item reference and a status, never the website password.

`computer_credentials fill` uses the item reference to fill the same HTTPS
origin. It reads the key and decrypts the item inside the worker, including
after the worker restarts. The browser page is hidden from model observations
while a login is being handled. If a site uses an unfamiliar or cross-origin
login, the user can finish through `computer_handoff` instead.

For CAPTCHA, MFA, or another step the agent cannot finish, `computer_handoff`
provides a one-use, ten-minute phone link. The user opens it, completes the
step in the same live browser, then taps Done. ClikCode starts Tailcat for this
handoff and closes it afterward. The phone connects over Tailcat's encrypted
transport; the browser version currently uses a DERP relay for its traffic.
The Tailcat address and a second random session token stay in the URL fragment,
which is not sent to the static page host. No ClikDeploy or Tailscale account is
needed for this handoff. ClikCode downloads and verifies the Tailcat binary on
first use when one is not installed, on supported platforms. The phone needs a
modern browser with WebAssembly and DecompressionStream support.

The optional `computer_web autofill` action triggers an installed Bitwarden
browser extension. The default private credential path uses ClikCode's local
vault and does not require Bitwarden.

The local key file is private to the OS account, but it is not an isolation
boundary against other processes running as that same user. ClikCode's shell
and desktop tools also run as that user. A separate OS identity and broker
would be required to prevent those tools from accessing the key or a signed-in
website. Sites may show an account email or ID after login.

The credential request form above still uses ClikDeploy as its ciphertext
relay. The phone browser handoff does not. Vendor harnesses do not automatically
receive ClikCode's own computer tools. The computer controls are available to
ClikCode's own agent in the terminal and VS Code.
