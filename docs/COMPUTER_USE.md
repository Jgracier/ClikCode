# Computer use

ClikCode's own agent can use a persistent Chrome browser through Playwright and
local desktop windows through Cua Driver. The feature is off until the user
runs `/computer on` in the terminal or VS Code panel, or `clikcode computer on`
in a shell. `/computer off` stops new actions and closes ClikCode's browser.

The browser has its own profile under ClikCode's state directory. It does not
attach to a personal Chrome profile. Existing signed-in sites in that profile
remain signed in across turns. A user can sign in to a site in that browser,
then ask the agent to continue.

Agent-triggered Bitwarden filling is not exposed yet. An installed extension
would share the browser profile with the agent's OS user, so a tool that only
hides its return value would not protect credentials. If a site requires a
password, CAPTCHA or MFA, the user must complete it in the local browser for
now.

This is not yet a protected credential broker. The browser runs as the same OS
user as ClikCode, and ClikCode's own agent can run shell commands. Do not treat
the browser profile as a secret store isolated from the agent. The current
tool hides visible password forms from its Playwright observation, but that
alone is not an OS security boundary.

Phone takeover from another device is not implemented. It requires an
account-authenticated, time-limited relay and a local pause while the user is
controlling the browser. No local browser port is exposed to the internet.

Vendor harnesses do not automatically receive ClikCode's own computer tools.
Their tool support and permission systems differ. The computer controls are
available through ClikCode's own agent in both the terminal and VS Code panel.
