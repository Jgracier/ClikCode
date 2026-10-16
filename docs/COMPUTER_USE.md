# Computer use

ClikCode's own agent can use a persistent Chrome browser through Playwright and
the primary desktop through Cua Driver. The feature is off until the user
runs `/computer on` in the terminal or VS Code panel, or `clikcode computer on`
in a shell. This enables the capability; the agent opens a URL in one action
when its task needs a browser, can use the desktop directly, and can close its
browser when finished. `/computer off` stops new actions and closes the browser.

The browser has its own profile under ClikCode's state directory. It does not
attach to a personal Chrome profile. Existing signed-in sites in that profile
remain signed in across turns. A user can sign in to a site in that browser,
then ask the agent to continue.

When a site needs a password, CAPTCHA or MFA, the agent can call
`computer_handoff`. ClikCode shows a ten-minute link; the user opens it on a
phone, finishes in the same live browser, then taps Done. The agent continues
from that page. The link is tied to the same ClikDeploy account. Screenshots
and taps pass through a temporary encrypted relay; the decryption key is in
the URL fragment, shown in the local ClikCode activity, and never sent to the
relay server. No desktop port is opened.

If the user has installed and unlocked Bitwarden in the ClikCode browser
profile, the agent can use `computer_web` with action `autofill`. That sends
Bitwarden's login shortcut and checks that the visible password field was
filled. The password is not returned to the model. A locked vault or unmatched
site can be handled with the phone handoff; the user can enter the password
there without putting it in chat. Bitwarden is never triggered on page load.

`computer_credentials` adds a private form for an HTTPS site already open in
the ClikCode browser. `request` shows a phone link for account ID, email and
password. The page encrypts those values to the local worker using the handoff
key in the URL fragment; the ClikDeploy relay holds ciphertext only. The worker
sends a new login item to the official Bitwarden CLI with a host-matched URI
and returns only its item ID to the model. `fill` accepts that ID only on the
same HTTPS origin and fills the fields without returning their values. If the
worker's temporary vault session has expired, `fill` opens a private vault
unlock form first. It can advance through ordinary split login forms locally;
an unfamiliar or cross-origin login falls back to the phone handoff. The
Bitwarden CLI must be installed and signed in once; the private form can supply
the vault master password to unlock it when needed. ClikCode keeps the CLI
session key in worker memory for up to ten minutes and forgets it when computer
use is switched off. It does not store the form values or vault password in
ClikCode settings.

The browser observation tool hides a login page from the model, including after
a site's show-password control changes the input type. Desktop observation and
actions are held while that private page is open. Open a new URL to leave the
private page after signing in; ClikCode closes the protected tab. The user can
still finish a difficult login through the phone handoff.

This keeps credentials out of the model's normal tool arguments and results.
It is not an OS security boundary: the agent's shell tool and ClikCode run as
the same OS user as the Bitwarden CLI. A fully isolated vault would require a
separate OS identity and a broker that never exposes vault access to shell or
desktop tools. A signed-in website can also display the account email or ID in
ordinary page content after login; those values cannot be guaranteed hidden
while the agent is allowed to use that website.

The phone link requires a ClikDeploy account connection on the local worker
and a browser session signed in to that same account on the phone. It expires
after ten minutes, and the user can finish sooner with Done.

Vendor harnesses do not automatically receive ClikCode's own computer tools.
Their tool support and permission systems differ. The computer controls are
available through ClikCode's own agent in both the terminal and VS Code panel.
