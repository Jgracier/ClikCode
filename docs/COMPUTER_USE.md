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

Agent-triggered Bitwarden filling is not exposed yet. An installed extension
would share the browser profile with the agent's OS user, so a tool that only
hides its return value would not protect credentials. The phone handoff lets
the user enter them without putting a password in chat.

This is not yet a protected credential broker. The browser runs as the same OS
user as ClikCode, and ClikCode's own agent can run shell commands. Do not treat
the browser profile as a secret store isolated from the agent. The current
tool hides visible password forms from its Playwright observation, but that
alone is not an OS security boundary.

The phone link requires a ClikDeploy account connection on the local worker
and a browser session signed in to that same account on the phone. It expires
after ten minutes, and the user can finish sooner with Done.

Vendor harnesses do not automatically receive ClikCode's own computer tools.
Their tool support and permission systems differ. The computer controls are
available through ClikCode's own agent in both the terminal and VS Code panel.
