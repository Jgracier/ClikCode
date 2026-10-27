/** Model downloads that run on their own: started once per model in this process, tied to no chat, no turn and no window's
 * waiting line, so switching chats, opening settings or sending a message in another chat goes on while one is fetched.
 *
 * What fetches is `prefetchLocalModel`: the files only. It resumes from its `.part` file, so a process that ends mid-way loses
 * nothing, and a second window asking for the same model waits on the first's lock and finds the files there. */
import { quiet } from '../runtime/lifecycle-log.js';
import { catalogModel } from './catalog.js';
import { prefetchLocalModel } from './index.js';
import { withDownloadLock } from './lifecycle.js';
import type { LocalModelProgress } from './index.js';

export interface ModelDownload {
  readonly modelId: string;
  /** The catalog's name for it, for what is said to the user. */
  readonly label: string;
  /** The last thing the fetch reported: a message, and bytes of total when it is a transfer. */
  progress: LocalModelProgress | undefined;
  /** The chats that asked for it. Its progress is shown in these chats and in no other. */
  readonly askers: ReadonlySet<string>;
  /** `sessionId` asked for it: it shows there from now on. Asking again, or another chat asking for the same model, adds nothing. */
  ask(sessionId: string): void;
  /** Settles when the files are on this machine; rejects with why they are not. */
  readonly done: Promise<void>;
  /** Stops it. The partial file stays for the next try. */
  cancel(): void;
}

const jobs = new Map<string, ModelDownload>();
const listeners = new Set<(download: ModelDownload) => void>();

/** Called on every report of every download in this process (the footer, the editor's busy line). */
export function onModelDownload(listener: (download: ModelDownload) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function modelDownloads(): readonly ModelDownload[] {
  return [...jobs.values()];
}

/** The model's download, started now -- or the one already running for it, which every asker shares. */
export function startModelDownload(modelId: string, fetch: typeof prefetchLocalModel = prefetchLocalModel): ModelDownload {
  const running = jobs.get(modelId);
  if (running) return running;
  const controller = new AbortController();
  const askers = new Set<string>();
  const job: ModelDownload = {
    modelId, label: catalogModel(modelId)?.label ?? modelId, progress: undefined, askers,
    ask: (sessionId) => { if (!askers.has(sessionId)) { askers.add(sessionId); tell(); } },
    done: Promise.resolve(), cancel: () => controller.abort(),
  };
  const tell = (): void => { for (const listener of [...listeners]) { try { listener(job); } catch (error) { quiet('local-models/downloads')(error); } } };
  (job as { done: Promise<void> }).done = withDownloadLock(modelId, () => fetch(modelId, (update) => { job.progress = update; tell(); }, controller.signal), controller.signal)
    .finally(() => { jobs.delete(modelId); job.progress = undefined; tell(); });
  // Whoever asked handles the failure; a job nobody awaits must not become an unhandled rejection.
  job.done.catch(quiet('local-models/downloads'));
  jobs.set(modelId, job);
  return job;
}

/** A host that outlives the command that asked -- a terminal window, the editor's bridge -- says downloads may too. Without one
 * (`clikcode sessions command`, a script) the process ends with the command, and a background download would die with it: the
 * caller waits for the fetch instead. Returns what withdraws it. */
export function allowBackgroundDownloads(): () => void {
  hosts += 1;
  let withdrawn = false;
  return () => { if (!withdrawn) { withdrawn = true; hosts -= 1; } };
}
let hosts = 0;
export const backgroundDownloadsAllowed = (): boolean => hosts > 0;

/** How a download a chat asked for ended: the model is on this machine and the chat moved to it (`switched`), or it is not and
 * the chat is as it was. `text` is what to tell the user. */
export interface DownloadOutcome {
  sessionId: string;
  modelId: string;
  switched: boolean;
  level: 'info' | 'error';
  text: string;
}
const outcomeListeners = new Set<(outcome: DownloadOutcome) => void>();
export function onDownloadOutcome(listener: (outcome: DownloadOutcome) => void): () => void {
  outcomeListeners.add(listener);
  return () => { outcomeListeners.delete(listener); };
}
export function reportDownloadOutcome(outcome: DownloadOutcome): void {
  for (const listener of [...outcomeListeners]) { try { listener(outcome); } catch (error) { quiet('local-models/downloads')(error); } }
}
