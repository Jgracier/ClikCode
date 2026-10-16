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
provides a ten-minute phone link. The user opens it, completes the step in the
same live browser, then taps Done. Screenshots and taps pass through a temporary
encrypted relay. The decryption key stays in the URL fragment and is not sent
to the relay server. No desktop port is opened.

The optional `computer_web autofill` action triggers an installed Bitwarden
browser extension. The default private credential path uses ClikCode's local
vault and does not require Bitwarden.

The local key file is private to the OS account, but it is not an isolation
boundary against other processes running as that same user. ClikCode's shell
and desktop tools also run as that user. A separate OS identity and broker
would be required to prevent those tools from accessing the key or a signed-in
website. Sites may show an account email or ID after login.

The phone link requires a ClikDeploy connection on the local worker and a
browser session signed in to the same account on the phone. Vendor harnesses
do not automatically receive ClikCode's own computer tools. The computer
controls are available to ClikCode's own agent in the terminal and VS Code.
