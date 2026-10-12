# Limits that remain on purpose

A limit stays only if removing it would leave a new way for a turn to hang or a request to be refused, and only if
reaching it is said, never silent. Each says what happens at it.

| Limit | Where | At the limit | Why it stays |
|---|---|---|---|
| Own-agent turn | none | ends when the model finishes, you press Esc, or a call fails 3 times in a row with nothing changed | a count of steps stopped legitimate long work |
| Failed step | `run-turn.ts` | retried for up to 5 minutes of waiting (1, 2, 4 ... 30 s, jittered, at least the server's `Retry-After`) | an outage must end with the real error, not hang |
| Request items | `context.ts` | summarized at 1,500 items; the Gateway refuses more than 2,000 | a server contract; summarizing keeps the chat going |
| Model stream | `gateway-client.ts` | cut after 120 s of silence once an answer has started | a dead connection otherwise hangs the turn; the Gateway sends a keepalive every 15 s |
| Vendor turn silence | `turn-watchdog.ts` | stopped after 10 minutes without a word (60 with a tool running); `CLIKCODE_TURN_IDLE_TIMEOUT_MS` changes it | a wedged vendor CLI |
| Vendor retry loop | `acp-client.ts` | 5 retries of one kind with no progress end the turn | a loop the vendor cannot leave |
| Tool output | context profile | first and last part kept, with a note | a prompt can only hold so much |
| Bash tool | `bash.ts` | 120 s by default, 600 s at most, or background | as Claude Code's |
| `!command` in the terminal | `shell-run.ts` | none; Esc stops it. A headless call stops at 30 minutes | the command is the user's own |
| Instruction files | `context.ts` | 32 KB in total; the file that crosses it is marked `[truncated]`, and files left out are named in the prompt | the system prompt is bounded at 64 KB |
| Tools sent to the Gateway | `openai-client.ts` | at most 128; any left out are named to the model | the server refuses more |
| Imported vendor chat | `session/discovery` | the last 200 messages | opening a years-long history must not bloat state |
| File rewind | `file-checkpoints.ts` | 50 turns or 200 MB | disk |
