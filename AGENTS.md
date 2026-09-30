# Working on ClikCode

## Never test against the user's own vendor history

Every harness ClikCode drives keeps its chats on disk (`~/.local/share/opencode`,
`~/.hermes`, `~/.cursor/chats`, `~/.codex/sessions`, ...), and ClikCode lists
those chats as the user's own. A live check run with the real home -- an ACP
`session/new`, a PONG turn, `clikcode send`, `opencode run` -- leaves a chat
there that the user then has to find and delete.

- Run any live vendor CLI, ACP agent or `clikcode` turn through
  `node scripts/vendor-sandbox.mjs [--auth <harness>] -- <command>`. It points
  HOME, XDG, CLIKCODE_HOME and each harness's profile variable at a temporary
  directory and deletes it afterwards.
- Prefer a harness signed out, or a model that needs no sign-in
  (`opencode/big-pickle`). `--auth <harness>` links in that harness's sign-in
  files when a signed-in run is genuinely needed.
- Automated tests do the same: a test that spawns a real vendor CLI sets its
  own HOME/XDG/profile directories, not just CLIKCODE_HOME.
- Code in ClikCode itself must not open a vendor session the user did not ask
  for. A background check that needs one (model discovery) cleans it up.
