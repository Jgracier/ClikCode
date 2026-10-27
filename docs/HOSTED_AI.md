# Hosted AI: one shape for a model that runs on compute somewhere

A hosted model is one that runs on compute, whoever owns the compute. The pickers (the terminal's `/model` and `/hosted`, the editor's model menu) know one shape, `HostedAdapter` (`src/hosted-models/types.ts`), the way ClikDeploy's compute providers (`packages/compute`) do: a target lists what it can run, says what starting one takes, and starts it.

| Target | Adapter | Runs on | Costs | Needs |
| --- | --- | --- | --- | --- |
| `this-computer` (tag **Local**) | `this-computer.ts`, ClikCode Local (`src/local-models/`) | this machine, by llama.cpp | free after a one-time download | nothing once downloaded: works offline and signed out |
| `clikdeploy` (tag **ClikDeploy GPU**) | `clikdeploy.ts`, the planner behind `/api/models/*` | a GPU ClikDeploy picks for the model | per hour while it runs | internet and a Gateway sign-in |

## The list

One list, one search. `hostedList` merges every target's rows, this computer's first (recommended before the rest), then the GPUs. Words in the search that name a place choose it: `local`, `offline`, `computer`, `here` mean this computer; `cloud`, `gpu`, `hosted`, `clikdeploy` mean ClikDeploy. The rest names the model. A target that cannot answer (offline, signed out) does not hide the other: it is named in `unavailable`, and the picker says why.

The two groups are headed **Fits this computer** and **On ClikDeploy** (in the terminal and in the editor), so which a model is is the group it is under, not a tag on each row. A model whose weights come from a repo ClikDeploy lists too appears once, under *Fits this computer*. A row says only what helps choose between models: for this computer what it takes (`6.7 GB download`, or `downloaded`) and how fast it writes (`~8 tok/s`), plus `tool use unverified` for a model found on Hugging Face, which has not shown it can make the tool calls a coding agent needs; for a GPU its parameters. The rest of what the ranking knows (the backend, the first-reply estimate, the context, where it came from) stays in `LocalModelChoice.detail`, which `/model` with no name still prints, and is not on this screen.

Only a model that fits this machine is tagged Local, with its download size and speed. The local side is a curated, ranked catalog (`local-models/catalog`) plus what `discover.ts` finds, not a raw Hugging Face search, so a model that is only on Hugging Face is offered on the GPU side alone.

## Starting one: run here, or on ClikDeploy

`hostedPlan(row)` says what choosing a row takes, before anything is spent or downloaded, and carries the other place to run it:

- **A model that fits this computer** has a plan for running here (`downloaded · free, works offline`, or `6.7 GB download · free after, works offline`) and, when ClikDeploy's planner can price it, an `alternative`: the same model on a GPU (`$0.068/hour · 1 GPU · 17 GB · ~52 tok/s`). ClikDeploy plans from a Hugging Face repo, and a local model is one -- its GGUF weights' repo (`HostedRow.repo`) -- so every model that fits can be priced, whether or not ClikDeploy's own search lists it. The question is then one line each: **Run on this computer** or **Run on ClikDeploy**. Choosing is the consent -- the size or the price is on the option -- so nothing is asked again. Enter takes the first.
- **A model that needs a GPU** has only its ClikDeploy estimate: one question (`Start X on ClikDeploy?` with the price, GPU and speed under *Start*), unless the user said to always start. Nothing about running it here, because it cannot.
- **A model that fits and cannot be priced** (signed out, offline, gated, or no answer within 6 s) is run here with no choice: a download asks once with its size, a model on disk asks nothing.

Esc at the question goes back to the list. The estimate is the planner's, not a promise: it can differ from what a deployment ends up as.

`start(row)` returns a `HostedSelection`: the route (`clikcode-local` or `gateway`) and the model id. A local model's download happens in the background (see below); a GPU deployment is created now, and the chat moves onto it with `hostedSelectionCommand`.

`clikcode-local` stays a route and a harness alias, so existing chats and scripts keep working; only the separate "ClikCode Local" entry in the pickers gives way to this list.

## Editor protocol (revision 9)

`query hosted` `{ search }` returns the merged list; `query hosted-plan` `{ row }` returns the plan, with `alternative` (the same model on ClikDeploy) when there is one -- an optional field, so no revision change: an older editor ignores it and a newer one with an older bridge never sees it; `choose { kind: 'hosted', row }` starts it and moves the chat. An older bridge has none of these, so the editor shows the Hosted AI row only for revision 9 or later.

## Not yet

- The user's other connected machines (ClikDeploy's `own-machine` provider, offered at $0 ahead of cloud GPUs) would come through the same adapter shape as another target; the planner side decides placement, so the picker needs no change beyond a tag.

## Downloads run on their own

A model for this computer that is not on disk yet is fetched by a background job (`local-models/downloads.ts`), not inside the command or the turn that asked. One job per model in the process, shared by every chat that asks for it; it takes a lock that only a dead process loses (`withDownloadLock`), so two windows never write one `.part` file, and it resumes from that file if the process ends.

- **Nothing is held, and it shows only where it was asked for.** The terminal's composer, chat switching, `/settings` and the other chats all work while it runs. Each download remembers the chats that asked for it (`ModelDownload.askers`), and its progress is drawn in those chats and no other: in the terminal a spinner row (`⠋ Downloading Qwen3.5 9B 16%`) in the status slot above the composer, or beside the status while a turn runs; in the editor the busy line of that chat. Another chat shows nothing of it, and the chat that asked shows it again when it is opened again. How it ended is said in that chat too -- at once if it is open, else the first time it is opened (`TerminalHarnessPrompter.noteFor`).
- **The chat is untouched until the files are there.** Then it moves onto the model (route and model together, as `/model` does for one already on disk) and the window says so. A failed download, or a chat the user changed meanwhile, moves nothing; a failure says it resumes where it stopped.
- **Loading is the first turn's.** The job fetches the llama.cpp build and the weights only. No server is started and no lease is taken until a turn needs the model, which waits on its own band as it always did.
- **A script waits.** `backgroundDownloadsAllowed()` is true only while a host that outlives the command (a terminal window, the editor's bridge) is open; `clikcode sessions command …` and the like have none, so they wait for the fetch.
