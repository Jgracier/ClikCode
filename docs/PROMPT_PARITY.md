# Prompt, tool and permission parity: ClikCode vs Claude Code 2.1.296 vs Codex 0.155.1

Sources: Claude Code's bundled prompt functions (`# Doing tasks`, `# Executing actions with care`,
`# Using your tools`, the PR/commit "Git Safety Protocol" text) in `~/.local/share/claude/versions/2.1.296`;
Codex's `base_instructions` and `turn_context` in `~/.codex/sessions/**/*.jsonl`. Quotes are short fragments.
ClikCode's wording is its own. Verdicts: **matches**, **differs-on-purpose**, **gap** (closed = fixed in this change).

| Area | Claude Code | Codex | ClikCode | Verdict |
|---|---|---|---|---|
| Doing tasks / scope | "Don't add features, refactor, or introduce abstractions beyond what the task requires" | "Diagnose: determine the cause... Do not implement the fix unless" asked | `context.ts` `DOING_TASKS`; previously only "smallest change" in `WORKING_METHOD` | gap, closed (exploratory questions get a recommendation, no unrequested extras, comments, security, verified-vs-assumed) |
| Tone / style | markdown in monospace, concise | "Only use as much formatting or structure as is required" | `COMMUNICATION`, `FORMATTING` | matches |
| Tool-use policy | "Prefer dedicated tools over ... shell"; "make all independent tool calls in parallel" | "prefer parallelization over sequential tool calls"; `apply_patch` for edits | `WORKING_METHOD`, `SHELL`; read-before-write is enforced in `write_file` code, not prompt | matches (enforced in code) |
| Git / commit / PR safety | "NEVER skip hooks (--no-verify...)", "NEVER update the git config", no `-i`, use `gh` | "Never use destructive commands like `git reset --hard`... unless the user has clearly asked"; non-interactive git | `GIT` section (new); `command-classifier.ts` ASK_PATTERNS: force push, `reset --hard`, `clean -f`, `--no-verify`/`--no-gpg-sign` now ask in every mode that is not bypass, and no allow rule waives them | gap, closed |
| Risky-action confirmation | "A user approving an action (like a git push) once does NOT mean that they approve it in all contexts" | escalation via approval policy | `RISKY_ACTIONS` (new) + approval flow in `permissions.ts` | gap, closed (short prompt; enforcement stays in code) |
| Plan mode | "you MUST NOT make any edits ... run any non-readonly tools" | Plan collaboration mode, `request_user_input` | `PLAN_MODE_INSTRUCTIONS`; code hides write/exec tools and denies them (`permissions.ts` plan branch) and gates exit on user approval | matches, stronger (code-enforced) |
| Todo usage | TodoWrite: use for 3+ steps, mark completed immediately | `update_plan` | `todo_write` description: one in_progress, complete as done, skip trivial | matches |
| Sub-agents | Task/Agent tool, parallel, self-contained prompt | collab / spawn tools | `tools/agent.ts` description (self-contained prompt, worktree isolation, background) | matches |
| Instruction files | `CLAUDE.md` (user, project, parents), `CLAUDE.local.md`, `@path` imports | `AGENTS.md` hierarchy | `loadMemoryChain` loads user AGENTS.md or `~/.claude/CLAUDE.md`, then per directory root→cwd: AGENTS.md else CLAUDE.md else `.claude/CLAUDE.md`, plus CLAUDE.local.md; `@imports` (depth 5, no code spans, no protected paths); 32 KB cap. Nested-on-demand (subdirectories discovered while reading) not done | gap, closed except subdirectory-on-demand (differs-on-purpose: prompt must stay byte-stable) |
| Permission modes | default / acceptEdits / plan / bypassPermissions / dontAsk | `approval_policy` (on-request, never...) x `sandbox_policy` (workspace-write, network_access) | ask / auto / bypass + plan flag. `auto` = Claude's acceptEdits plus safe read-only commands. `dontAsk` is covered by "no approver attached → deny" | differs-on-purpose (mode set is the harness's three-value `AiHarnessPermissionMode`) |
| Rule syntax | `Bash(git push:*)`, `Edit(src/**)`, `WebFetch(domain:x)`; deny > ask > allow | Starlark-ish exec policy rules | same syntax; added `deny` and `ask` lists (`permissions.ts` `parsePermissionSettings`), deny > ask > allow, compound/substituted commands checked per segment, deny holds in bypass. Loaded from `.clikcode/settings(.local).json` and `.claude/settings(.local).json`; **allow only from the local file** so a repo cannot grant itself permission | gap, closed |
| Protected paths | `.git`, settings files, shell rc dangerous | sandbox read-only `.git`/`.codex` | `security.ts` `writeDenyReason` (.git, ~/.ssh etc, agent settings, `.mcp.json`) in every mode | matches |
| Sandbox / approval levels | sandbox on by default in Claude Code | workspace-write, no network | `bash.ts`: sandbox "workspace" by default, `sandbox:false` goes through the permission mode | matches |
| Hooks | `~/.claude/settings.json` + project, PreToolUse etc | hooks config | `hooks.ts` reads Claude's files, project hooks behind workspace trust | matches |
| Skills | `Skill` tool, SKILL.md frontmatter | skills | `skills.ts`, profile-sized catalog in the prompt | matches |
| MCP | `mcp__server__tool` rules; server-claimed read-only is not trusted for approval | MCP tool approvals | `permissions.ts`: MCP tools only matched by exact name, `readOnlyHint` does not skip the question in ask mode | matches |

## Left as differs-on-purpose
- Prompt stays short and byte-stable (`context.ts` header): nested CLAUDE.md discovered mid-session would break the cache; plan/todo/subagent behaviour lives in code and tool descriptions.
- Mode names: ClikCode keeps the harness's `ask`/`auto`/`bypass`.
- Hooks, skills, MCP: no code change; already follow Claude's files and semantics.

## Not verified
- No live model turn was run, so whether the new sections change model behaviour is untested.
- Codex's exec-policy rule file format was not mapped to ClikCode rules.
- Full suite not run; `src/agent` + `src/harness` run has 4 failures in `sandbox.vitest.test.ts` (7 on base, environment-dependent).
