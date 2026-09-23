# Security policy

## Reporting a vulnerability

Please report security issues privately, not in a public issue. Use GitHub's
**Report a vulnerability** button on the repository's Security tab
(private vulnerability reporting). Include what you found, how to reproduce it,
and the ClikCode version (`clikcode --version`).

We will acknowledge a report within a few days and keep you updated until it is
resolved.

## What ClikCode handles

- ClikCode never reads your vendor sign-in credentials; sign-in happens inside
  each tool. It records only which account is which.
- A ClikDeploy Gateway credential, if you sign in, is stored under
  `~/.config/clikcode/auth.json` and `~/.clikcode/api-key`.
- Environment variables that look like secrets are scrubbed before commands run
  by ClikCode's own coding agent.

Issues in these areas are especially welcome.
