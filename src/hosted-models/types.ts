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
}

/** What starting one takes, said before anything is spent or downloaded. */
export interface HostedPlan {
  title: string;
  /** Wrapped lines: where it runs, the size or price, speed, notes. */
  lines: string[];
  /** The button: what the click does. */
  confirm: string;
  /** It bills by the hour. A target that bills always asks first, unless the user said to always start. */
  costly: boolean;
}

/** Where the chat goes once the model is ready. */
export interface HostedSelection {
  /** The conversation's route: ClikCode Local, or the ClikDeploy Gateway. */
  route: 'clikcode-local' | 'gateway';
  /** The model id to select on that route. */
  model: string;
  /** `/model --download`: the user has seen the size and accepted it. */
  download?: true;
  /** `/model --any`: a model id the Gateway's own list does not carry (a deployment of the user's). */
  any?: true;
}

export interface HostedAdapter {
  readonly target: HostedTarget;
  /** What this target can run, best first. An empty query is its default list. Rejects when it is unreachable. */
  list(query: string, signal?: AbortSignal): Promise<HostedRow[]>;
  /** What starting `row` takes. */
  plan(row: HostedRow): Promise<HostedPlan>;
  /** Starts it (downloads are left to the first turn, after the plan was accepted). */
  start(row: HostedRow): Promise<HostedSelection>;
}

/** The merged list, and the targets that could not answer (offline, signed out). */
export interface HostedList {
  rows: HostedRow[];
  unavailable: Array<{ target: HostedTarget; message: string }>;
}

/** The words the picker shows on a row. */
export const HOSTED_TAGS: Readonly<Record<HostedTarget, string>> = {
  'this-computer': 'Local',
  clikdeploy: 'ClikDeploy GPU',
};

/** The slash command that selects a started model. */
export function hostedSelectionCommand(selection: HostedSelection): string {
  return `/model ${selection.download ? '--download ' : ''}${selection.any ? '--any ' : ''}${selection.model}`;
}
