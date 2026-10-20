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
 * or an agent's task to start again. */
import { readFile } from 'node:fs/promises';
import { asRecord, type JsonRecord } from '../protocol/json-lines.js';
import { redactSecrets } from '../../agent/security.js';
import { BackgroundWorkTracker } from './background-work.js';

/** How much of an agent's result goes to the conversation. */
const RESULT_CHARS = 4_000;

/** A Claude background agent's answer: the last assistant text in its transcript (its task's
 * output file), not a synthetic API error. Empty when there is none. */
export async function agentResult(file: string | undefined): Promise<string> {
  if (!file) return '';
  const text = await readFile(file, 'utf8').catch(() => '');
  const lines = text.slice(-400_000).split('\n');
  for (let index = lines.length - 1; index >= 0; index--) {
    let record: JsonRecord | undefined;
    try { record = asRecord(JSON.parse(lines[index]!)); } catch { continue; }
    const message = asRecord(record?.message);
    if (record?.type !== 'assistant' || record.isApiErrorMessage === true || !message || message.model === '<synthetic>') continue;
    const said = Array.isArray(message.content)
      ? message.content.map((part) => { const item = asRecord(part); return item?.type === 'text' && typeof item.text === 'string' ? item.text : ''; }).join('').trim()
      : '';
    if (said) return redactSecrets(said.length > RESULT_CHARS ? `${said.slice(0, RESULT_CHARS)}...` : said);
  }
  return '';
}

export interface RunningWork {
  /** The vendor's id for it (Claude's task id), or the command's pid. */
  id: string;
  kind: 'command' | 'agent';
  /** The command line, or the agent's description. */
  label: string;
  /** An agent's task, as it was given: what starting it again needs. */
  prompt?: string;
  /** Where a command writes its output. */
  outputFile?: string;
}

export interface EndedWork extends RunningWork {
  /** `finished`: it ran to its end. `cut-off`: it stopped before it could --
   * the account ran out, or the process holding it went. */
  outcome: 'finished' | 'cut-off';
  /** What it left: a command's output tail, an agent's result or failure. */
  tail: string;
  /** The vendor's usage-limit sentence, when that is what cut it off. */
  limit?: string;
}

/** Told each piece of work that ended in a process the conversation left, and
 * each agent the account's usage limit cut off. */
export type WorkEndedHandler = (ended: readonly EndedWork[]) => void;

/** The vendor's own "you are out" sentence: Claude's "You've hit your session limit · resets
 * 7:50am", Codex's "You've hit your usage limit". Only these words: a model writing about limits
 * ("I raised the rate limit") is not the vendor refusing. */
const LIMIT_SENTENCE = /you(?:'|’)ve hit your (?:\w+ ){0,2}limit\b[^\n]*/i;

/** The vendor's usage-limit sentence in `text`, if it says one. */
export function limitSentence(text: string): string | undefined {
  return LIMIT_SENTENCE.exec(text)?.[0].trim();
}

/** Claude's refusal as it ends a reply it could not give: "You've hit your session limit · resets
 * 7:50am (America/Denver)" -- the vendor's format, reset time and all, as the reply's last words. A
 * model quoting the words mid-answer, or without the reset, is not it. */
const REPLY_REFUSAL = /you(?:'|’)ve hit your (?:\w+ ){0,2}limit · resets (?:[A-Z][a-z]{2} \d{1,2}, )?\d{1,2}(?::\d{2})?\s?[ap]m(?: \([^)\n]+\))?$/i;

/** The refusal `reply` ends with, if it ends with Claude's. */
export function endsWithLimitRefusal(reply: string): string | undefined {
  return REPLY_REFUSAL.exec(reply.trimEnd())?.[0];
}

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
  private readonly byCall = new Map<string, string>();

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
    const call = typeof record.tool_use_id === 'string' ? record.tool_use_id : undefined;
    if (record.subtype === 'task_started') {
      const type = String(record.task_type ?? (typeof record.subagent_type === 'string' ? 'local_agent' : ''));
      if (record.owned_by_subagent === true || (type !== 'local_agent' && type !== 'local_bash')) return undefined;
      const prompt = typeof record.prompt === 'string' && record.prompt ? record.prompt : call ? this.prompts.get(call) : undefined;
      const agent = type === 'local_agent';
      // A task started again is the task as it is now.
      this.tasks.end(id);
      this.tasks.start({
        id, kind: agent ? 'agent' : 'command', label: String(record.description ?? '') || (agent ? 'background agent' : 'background command'),
        ...(prompt ? { prompt } : {}), background: record.is_backgrounded !== false,
      });
      if (call) this.byCall.set(call, id);
      return undefined;
    }
    if (record.subtype !== 'task_notification') return undefined;
    const task = this.tasks.end(id);
    if (!task) return undefined;
    for (const [key, value] of this.byCall) if (value === id) this.byCall.delete(key);
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

  clear(): void { this.tasks.clear(); this.byCall.clear(); }
}

/** A task as the conversation is told it. */
const work = ({ background: _background, ...task }: Task): RunningWork => task;
