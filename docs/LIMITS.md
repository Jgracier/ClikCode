# Limits that remain on purpose

A limit stays only if removing it would leave a new way for a turn to hang or a request to be refused, and only if
reaching it is said, never silent. Each says what happens at it.

| Limit | Where | At the limit | Why it stays |
|---|---|---|---|
| Own-agent turn | none | ends when the model finishes, you press Esc, or a call fails 3 times in a row with nothing changed | a count of steps stopped legitimate long work |
| Failed step | `turn-recovery.ts` | retried for up to 5 minutes of waiting (1, 2, 4 ... 30 s, jittered, at least the server's `Retry-After`). A busy model (`MODEL_BUSY`) spends the same budget | an outage must end with the real error, not hang; nothing reports when an outage or a busy model ends |
| Own model starting | `turn-recovery.ts` | waited for while the Gateway reports it starting; ends when the start has taken twice the Gateway's own expected time (`expectedS`). A start nothing reports on spends the step retry budget | derived from the Gateway's status, not a clock of ours; a model reported still starting is waited for even when the Gateway answers `MODEL_BUSY` |
| Held vendor process | `held-vendor.ts` | no clock. On the same account a turn waits for its sub-agents until the vendor reports the last one (or the process exits, or you stop); a conversation that leaves it (another account, another tool, a failed reply) retires it: sub-agents run on, their end told to the conversation | the vendor's own report ends it; a timer killed work that was still useful |
| Stop | `worker-live-commands.ts` | with sub-agents running, Esc or Ctrl+C is held once and says so; the next press stops. A turn that has not ended 8 s after a stop is ended by force | a stop must never leave a window "stopping"; abort is cooperative |
| History seeded to the own agent | `agent-history.ts` | half the target model's window; older turns are named with the file that holds the whole conversation | derived from the window; the context view still fits every request |
| Gateway credit | `credit-label.ts` | read when a turn ends, the account or conversation changes or the window appears; the 15 s redraw shows the last reading | the balance moves only on those |
| Request items | `context.ts` | summarized at 1,500 items; the Gateway refuses more than 2,000 | a server contract; summarizing keeps the chat going |
| Model stream | `gateway-client.ts` | cut after eight Gateway keepalives (120 s) of silence, or four times the longest pause that stream has shown, whichever is longer | a dead connection otherwise hangs the turn; the Gateway sends a keepalive every 15 s |
| Tool output | context profile | first and last part kept, with a note | a prompt can only hold so much |
| Bash tool | `bash.ts` | 120 s by default, 600 s at most, or background | as Claude Code's |
| `!command` in the terminal | `shell-run.ts` | none; Esc stops it. A headless call stops at 30 minutes | the command is the user's own |
| Instruction files | `context.ts` | 32 KB in total; the file that crosses it is marked `[truncated]`, and files left out are named in the prompt | the system prompt is bounded at 64 KB |
| Tools sent to the Gateway | `openai-client.ts` | at most 128; any left out are named to the model | the server refuses more |
| Imported vendor chat | `session/discovery` | the last 200 messages | opening a years-long history must not bloat state |
| File rewind | `file-checkpoints.ts` | 50 turns or 200 MB | disk |
