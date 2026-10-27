# Hosted AI: one shape for a model that runs on compute somewhere

A hosted model is one that runs on compute, whoever owns the compute. The pickers (the terminal's `/model` and `/hosted`, the editor's model menu) know one shape, `HostedAdapter` (`src/hosted-models/types.ts`), the way ClikDeploy's compute providers (`packages/compute`) do: a target lists what it can run, says what starting one takes, and starts it.

| Target | Adapter | Runs on | Costs | Needs |
| --- | --- | --- | --- | --- |
| `this-computer` (tag **Local**) | `this-computer.ts`, ClikCode Local (`src/local-models/`) | this machine, by llama.cpp | free after a one-time download | nothing once downloaded: works offline and signed out |
| `clikdeploy` (tag **ClikDeploy GPU**) | `clikdeploy.ts`, the planner behind `/api/models/*` | a GPU ClikDeploy picks for the model | per hour while it runs | internet and a Gateway sign-in |

## The list

One list, one search. `hostedList` merges every target's rows, this computer's first (recommended before the rest), then the GPUs. Words in the search that name a place choose it: `local`, `offline`, `computer`, `here` mean this computer; `cloud`, `gpu`, `hosted`, `clikdeploy` mean ClikDeploy. The rest names the model. A target that cannot answer (offline, signed out) does not hide the other: it is named in `unavailable`, and the picker says why.

Only a model that fits this machine is tagged Local, with its download size and speed. The local side is a curated, ranked catalog (`local-models/catalog`) plus what `discover.ts` finds, not a raw Hugging Face search, so a model that is only on Hugging Face is offered on the GPU side alone.

## Starting one

1. `plan(row)` says what it takes, before anything is spent or downloaded: for a local model the download size and that it works offline afterwards; for a GPU the planner's GPU, speed, context and price per hour.
2. The user confirms. A GPU always asks (unless the user chose "always start hosted AI models"); a local model tells its download and asks once.
3. `start(row)` returns a `HostedSelection`: the route (`clikcode-local` or `gateway`) and the model id. A local model's download happens on its first turn, with `/model --download` recording that the size was accepted; a GPU deployment is created now, and the first prompt waits for it to be ready.
4. The chat moves onto that route (history and all, as a provider change does) and `hostedSelectionCommand` selects the model.

`clikcode-local` stays a route and a harness alias, so existing chats and scripts keep working; only the separate "ClikCode Local" entry in the pickers gives way to this list.

## Editor protocol (revision 9)

`query hosted` `{ search }` returns the merged list; `query hosted-plan` `{ row }` returns the plan; `choose { kind: 'hosted', row }` starts it and moves the chat. An older bridge has none of these, so the editor shows the Hosted AI row only for revision 9 or later.

## Not yet

- The user's other connected machines (ClikDeploy's `own-machine` provider, offered at $0 ahead of cloud GPUs) would come through the same adapter shape as another target; the planner side decides placement, so the picker needs no change beyond a tag.

## Downloads run on their own

A model for this computer that is not on disk yet is fetched by a background job (`local-models/downloads.ts`), not inside the command or the turn that asked. One job per model in the process, shared by every chat that asks for it; it takes a lock that only a dead process loses (`withDownloadLock`), so two windows never write one `.part` file, and it resumes from that file if the process ends.

- **Nothing is held.** The terminal's composer, chat switching, `/settings` and the other chats all work while it runs. Progress is one footer segment per window (`↓ Qwen3.5 9B 16%`), kept when the chat shown changes; the editor shows it on every chat's busy line.
- **The chat is untouched until the files are there.** Then it moves onto the model (route and model together, as `/model` does for one already on disk) and the window says so. A failed download, or a chat the user changed meanwhile, moves nothing; a failure says it resumes where it stopped.
- **Loading is the first turn's.** The job fetches the llama.cpp build and the weights only. No server is started and no lease is taken until a turn needs the model, which waits on its own band as it always did.
- **A script waits.** `backgroundDownloadsAllowed()` is true only while a host that outlives the command (a terminal window, the editor's bridge) is open; `clikcode sessions command …` and the like have none, so they wait for the fetch.
