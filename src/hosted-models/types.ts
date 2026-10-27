/** Hosted AI: one shape for a model that runs on compute somewhere, whoever owns the compute.
 *
 * A target is an adapter, as ClikDeploy's compute providers are: it lists what it can run, says what
 * starting one costs and takes, and starts it. The pickers (the terminal's /model, the editor's menu) know
 * only this shape. `this-computer` is ClikCode Local: fitted to this machine, downloaded once, then free and
 * offline. `clikdeploy` is ClikDeploy's planner: it picks the GPU for the model and bills per hour. */

export type HostedTarget = 'this-computer' | 'clikdeploy';

export interface HostedRow {
  target: HostedTarget;
  /** The target's own id: a local catalog id, or a Hugging Face model id. */
  id: string;
  label: string;
  /** What the row says about running it there (fit and speed; parameters). */
  detail: string;
  /** This computer: bytes still to download; 0 when the model is on disk. */
  downloadBytes?: number;
  /** Passes the target's speed bar. */
  recommended?: boolean;
  /** Needs access granted at Hugging Face first. */
  gated?: boolean;
  /** The Hugging Face repo ClikDeploy can plan this model from. A model for this computer is a repo too (its GGUF weights), so the same
   * model can be priced to run on a GPU. */
  repo?: string;
}

/** What starting one takes, said before anything is spent or downloaded. */
export interface HostedPlan {
  title: string;
  /** Wrapped lines: where it runs, the size or price, speed, notes. */
  lines: string[];
  /** The button: what the click does. */
  confirm: string;
  /** There is something to agree to: a download, or a price. False (a model already on this computer) means choosing the row is the
   * whole decision and nothing is asked. Absent is true, for a bridge that does not say. */
  consent?: boolean;
  /** It bills by the hour. A target that bills always asks first, unless the user said to always start. */
  costly: boolean;
  /** One short line for a question that sets this plan beside another: what it takes ("downloaded · free, works offline",
   * "$0.07/hour · 1 GPU · 17 GB · ~52 tok/s"). */
  summary: string;
  /** The same model run somewhere else, offered beside this plan: a model that fits this computer can also run on ClikDeploy, priced
   * by its planner. Absent when it cannot (it does not fit here, the Gateway is not signed in, or it did not answer in time). */
  alternative?: { row: HostedRow; plan: HostedPlan };
}

/** Where the chat goes once the model is ready. */
export interface HostedSelection {
  /** The conversation's route: ClikCode Local, or the ClikDeploy Gateway. */
  route: 'clikcode-local' | 'gateway';
  /** The model id to select on that route. */
  model: string;
  /** `/model --download`: a model for this computer, fetched if it is not here yet (the user has seen the size and accepted it). The
   * command moves the chat to it when it is there. */
  download?: true;
  /** `/model --any`: a model id the Gateway's own list does not carry (a deployment of the user's). */
  any?: true;
}

export interface HostedAdapter {
  readonly target: HostedTarget;
  /** What this target can run, best first. An empty query is its default list. Rejects when it is unreachable. */
  list(query: string, signal?: AbortSignal): Promise<HostedRow[]>;
  /** What starting `row` takes. */
  plan(row: HostedRow, signal?: AbortSignal): Promise<HostedPlan>;
  /** Starts it (downloads are left to the first turn, after the plan was accepted). */
  start(row: HostedRow): Promise<HostedSelection>;
}

/** The merged list, and the targets that could not answer (offline, signed out). */
export interface HostedList {
  rows: HostedRow[];
  unavailable: Array<{ target: HostedTarget; message: string }>;
  /** More models are still being looked for in the background (a refresh of what Hugging Face has): ask again shortly. */
  refreshing?: true;
}

/** The slash command that selects a started model. */
export function hostedSelectionCommand(selection: HostedSelection): string {
  return `/model ${selection.download ? '--download ' : ''}${selection.any ? '--any ' : ''}${selection.model}`;
}
