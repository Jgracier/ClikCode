/** Work a vendor process started that outlives the turn that started it -- a
 * background command, a background sub-agent -- and what became of it.
 *
 * ClikCode answers for that work, not the vendor process. When the
 * conversation moves to another account or provider, the process it leaves is
 * not waited on (a chat once sat an hour behind a watcher loop on an account
 * that could no longer answer) and not killed with its work: it is retired
 * (persistent-session.ts). Its commands run on; its agents run on, or are cut
 * off. Each one's end is told to the conversation as a notification its
 * current account reads (a queued turn the model alone sees): a result to use,
 * or an agent's task to start again.
 *
 * Every transport reports an end the same way: an EndedWork whose `failure` is the structured
 * evidence of why it stopped (FailureEvidence), into the one ledger of finished work
 * (turn/vendor-process.ts reportEndedWork). What the evidence means for the account is decided
 * there, once, by turn/account-evidence.ts. */
import { quiet } from '../../runtime/lifecycle-log.js';
import { open } from 'node:fs/promises';
import { asRecord, type JsonRecord } from '../protocol/json-lines.js';
import { redactSecrets } from '../../agent/security.js';
import { BackgroundWorkTracker, type WorkItem } from './background-work.js';

/** How much of an agent's result goes to the conversation. */
const RESULT_CHARS = 4_000;

/** What a transport knows of why work stopped, in fields rather than sentences. Every transport
 * supplies this for the work it reports ended -- the adapter of its own frames:
 *  - Claude (ACP `_claude/sdkMessage`, stream-json): the API-error envelope of `task_notification`'s
 *    summary (error type, HTTP status) and the flags of the agent's saved transcript
 *    (`isApiErrorMessage`, `error: 'rate_limit'`, the synthetic model);
 *  - Codex app-server: the sub-agent thread's failed `turn/completed` error (`codexErrorInfo`,
 *    HTTP status), through codexErrorKind;
 *  - Amp stream-json: the `subagent_finished` record's status and error, or the failed Task result;
 *  - the direct API: the response status (failover.ts agentTurnFailureKind).
 * turn/account-evidence.ts reads it the same way for all of them and for a main turn's failure. */
export interface FailureEvidence {
  /** HTTP/API status the vendor reported. */
  statusCode?: number;
  /** The vendor's error type or code ('rate_limit', 'quota', 'usageLimitExceeded'). */
  errorKind?: string;
  /** The vendor's rate-limit event status ('rejected' when the window is spent). */
  rateLimitStatus?: string;
  /** Whether `text` is the vendor's own error, safe to read for a refusal. False: it is an agent's
   * or a command's own words, which may be about limits without being one. Unset: an error the
   * transport raised itself. */
  vendorError?: boolean;
  /** The vendor's words, as supporting detail. */
  text?: string;
}

/** A Claude background agent's answer: the last assistant text in its transcript (its task's
 * output file), not a synthetic API error. Empty when there is none. */
export async function agentResult(file: string | undefined): Promise<string> {
  return (await agentTranscriptResult(file)).tail;
}

/** The agent's answer, and, when its last record is one the vendor itself marked as a failed API call
 * (`isApiErrorMessage`, `error: 'rate_limit'`, the synthetic model), that failure as evidence:
 * structured, so nothing of the words is needed to know the agent was cut off. */
async function agentTranscriptResult(file: string | undefined): Promise<{ tail: string; failure?: FailureEvidence }> {
  if (!file) return { tail: '' };
  const handle = await open(file, 'r').catch(quiet('harness/transport/handoff-work'));
  if (!handle) return { tail: '' };
  let text: string;
  try {
    const size = (await handle.stat()).size;
    const buffer = Buffer.alloc(Math.min(size, 400_000));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, Math.max(0, size - buffer.length));
    text = buffer.toString('utf8', 0, bytesRead);
  } finally { await handle.close(); }
  const lines = text.slice(-400_000).split('\n');
  let lastAssistant = true;
  let failure: FailureEvidence | undefined;
  for (let index = lines.length - 1; index >= 0; index--) {
    let record: JsonRecord | undefined;
    try { record = asRecord(JSON.parse(lines[index]!)); } catch { continue; }
    const message = asRecord(record?.message);
    if (record?.type !== 'assistant' || !message) continue;
    const said = Array.isArray(message.content)
      ? message.content.map((part) => { const item = asRecord(part); return item?.type === 'text' && typeof item.text === 'string' ? item.text : ''; }).join('').trim()
      : '';
    const apiError = record.isApiErrorMessage === true || record.error === 'rate_limit' || message.model === '<synthetic>';
    if (lastAssistant && apiError) {
      failure = { vendorError: true, ...(typeof record.error === 'string' ? { errorKind: record.error } : {}), ...(said ? { text: said } : {}) };
    }
    lastAssistant = false;
    if (apiError) continue;
    if (said) return { tail: redactSecrets(said.length > RESULT_CHARS ? `${said.slice(0, RESULT_CHARS)}...` : said), ...(failure ? { failure } : {}) };
  }
  return { tail: '', ...(failure ? { failure } : {}) };
}

/** Claude's envelope for an agent that stopped on a failed API call, in the summary of its
 * `task_notification`: `Agent "x" failed: Agent terminated early due to an API error: <detail> (error
 * type rate_limit, HTTP 429, request id ...)`. The vendor writes the error type and the status as
 * fields of that envelope, and they are read as fields. Anything else a failed agent's summary says
 * is the agent's own report, which may be prose about limits without being the vendor refusing. */
const API_ERROR_ENVELOPE = /terminated early due to an API error: ([\s\S]*?)(?: \(error type ([\w-]+)(?:, HTTP (\d{3}))?[^)]*\))?\s*$/;

/** The adapter for Claude's `task_notification`: why a task that did not complete stopped. */
function claudeTaskFailure(status: string, summary: string): FailureEvidence | undefined {
  if (status === 'completed') return undefined;
  const envelope = API_ERROR_ENVELOPE.exec(summary);
  if (!envelope) return { vendorError: false, ...(summary ? { text: summary } : {}) };
  const [, detail, errorKind, statusCode] = envelope;
  return {
    vendorError: true, ...(errorKind ? { errorKind } : {}), ...(statusCode ? { statusCode: Number(statusCode) } : {}),
    ...(detail?.trim() ? { text: detail.trim() } : {}),
  };
}

/** Task completion and request success are different facts: Claude may mark a task completed whose
 * last API response was a quota refusal. The evidence is the transcript's own flags and the
 * notification's envelope, merged: the transcript says it was an API error, the envelope its status. */
export async function endedAgentWork(work: RunningWork, status: string, summary: string, outputFile?: string): Promise<EndedWork> {
  const result = await agentTranscriptResult(outputFile).catch(() => ({ tail: '' } as { tail: string; failure?: FailureEvidence }));
  const noted = claudeTaskFailure(status, summary);
  // The transcript says it was an API error; the envelope, when it is the vendor's, adds the status and error type.
  const failure: FailureEvidence | undefined = result.failure ? { ...(noted?.vendorError ? noted : {}), ...result.failure, ...(result.failure.text ? {} : noted?.text ? { text: noted.text } : {}) } : noted;
  return { ...work, outcome: status === 'completed' && !result.failure ? 'finished' : 'cut-off',
    tail: result.tail || summary, ...(outputFile ? { outputFile } : {}), ...(failure ? { failure } : {}) };
}

/** Work the conversation answers for: a command or an agent (background-work.ts). */
export type RunningWork = WorkItem & { kind: 'command' | 'agent' };

export interface EndedWork extends RunningWork {
  /** `finished`: it ran to its end. `cut-off`: it stopped before it could --
   * the account ran out, or the process holding it went. */
  outcome: 'finished' | 'cut-off';
  /** What it left: a command's output tail, an agent's result or failure. */
  tail: string;
  /** Why it stopped, when the transport knows (FailureEvidence). */
  failure?: FailureEvidence;
}

/** Whose work ended: the harness and account the process ran as, and whether the conversation had
 * already left that process (retired). */
export interface EndedFrom { harness?: string; accountId?: string; retired?: boolean }

/** Told each piece of work that ended (turn/vendor-process.ts reportEndedWork decides which). */
export type WorkEndedHandler = (ended: readonly EndedWork[], from?: EndedFrom) => void;

/** A task as tracked: foreground ones too, whose end is still read. */
type Task = RunningWork & { background: boolean };

/** Claude Code's background tasks, from its `task_started` / `task_notification` frames (the same
 * frames as stream-json lines or claude-agent-acp's raw `_claude/sdkMessage`). Only work that runs
 * on past its call: a backgrounded agent or shell, not a foreground one whose call result is its end,
 * and not a sub-agent's own tasks (its agent answers for them). */
export class VendorTasks {
  private readonly tasks = new BackgroundWorkTracker<Task>();
  /** Agent prompts from the launching calls, by call id: a `task_started` may not carry one. */
  private readonly prompts = new Map<string, string>();

  /** A tool call's input: an Agent call's prompt is kept for its task. */
  call(id: string | undefined, input: unknown): void {
    const prompt = asRecord(input)?.prompt;
    if (!id || typeof prompt !== 'string' || !prompt) return;
    this.prompts.set(id, prompt);
    // Bounded: a long session launches many agents.
    if (this.prompts.size > 200) this.prompts.delete(this.prompts.keys().next().value!);
  }

  /** One `system` record. A task that ended comes back with how. */
  frame(record: JsonRecord): { work: RunningWork; status: string; summary: string; outputFile?: string } | undefined {
    if (record.type !== 'system') return undefined;
    const id = typeof record.task_id === 'string' ? record.task_id : undefined;
    if (!id) return undefined;
    if (record.subtype === 'task_started') {
      const call = typeof record.tool_use_id === 'string' ? record.tool_use_id : undefined;
      const type = String(record.task_type ?? (typeof record.subagent_type === 'string' ? 'local_agent' : ''));
      if (record.owned_by_subagent === true || (type !== 'local_agent' && type !== 'local_bash')) return undefined;
      const prompt = typeof record.prompt === 'string' && record.prompt ? record.prompt : call ? this.prompts.get(call) : undefined;
      const agent = type === 'local_agent';
      // A task started again is the task as it is now.
      this.tasks.end(id);
      this.tasks.start({
        id, kind: agent ? 'agent' : 'command', label: String(record.description ?? '') || (agent ? 'background agent' : 'background command'),
        ...(typeof record.session_id === 'string' ? { nativeSessionId: record.session_id } : {}),
        ...(prompt ? { prompt } : {}), background: record.is_backgrounded !== false,
      });
      return undefined;
    }
    if (record.subtype !== 'task_notification') return undefined;
    const task = this.tasks.end(id);
    if (!task) return undefined;
    return {
      work: work(task),
      status: String(record.status ?? 'completed'),
      summary: typeof record.summary === 'string' ? record.summary : '',
      ...(typeof record.output_file === 'string' && record.output_file ? { outputFile: record.output_file } : {}),
    };
  }

  /** Backgrounded work still running. */
  running(): RunningWork[] {
    return this.tasks.running().filter((task) => task.background).map(work);
  }

  clear(): void { this.tasks.clear(); }
}

/** A task as the conversation is told it. */
const work = ({ background: _background, ...task }: Task): RunningWork => task;
