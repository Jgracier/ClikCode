/** Reading one sub-agent as the rows of a chat of its own.
 *
 * One row shape for every source (docs/SUBAGENTS.md `read`): the prompt it was
 * given, its prose, and its calls as ordinary activity rows. A source is only
 * written where the vendor gives a client the means (a Claude sub-agent's
 * transcript on disk, a Codex child thread, the live `parentId` frames);
 * nothing is read from anywhere else. */
import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { HarnessActivityEvent } from './prompter.js';
import { claudeProjectDirectoryNames } from '../session/discovery/vendors/claude.js';
import { thoughtLabel, toolCall, toolFacts } from './protocol/activity-events.js';
import { mergeActivity } from './protocol/activity-view.js';
import { normalizeActivityEvent } from './protocol/activity-normalize.js';

export type SubAgentRow =
  | { kind: 'prompt'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'activity'; event: HarnessActivityEvent };

type Json = Record<string, unknown>;
const record = (value: unknown): Json | undefined => (value && typeof value === 'object' && !Array.isArray(value) ? value as Json : undefined);

/** Folds rows in order: an activity frame merges into the row with its id
 * (a start, then its result), adjacent prose joins, and a row never moves. */
class Rows {
  readonly rows: SubAgentRow[] = [];
  private readonly at = new Map<string, number>();

  prompt(text: string): void { if (text.trim() && !this.rows.some((row) => row.kind === 'prompt')) this.rows.push({ kind: 'prompt', text: text.trim() }); }
  text(text: string): void {
    if (!text.trim()) return;
    const last = this.rows[this.rows.length - 1];
    if (last?.kind === 'text') last.text += text; else this.rows.push({ kind: 'text', text });
  }
  activity(event: HarnessActivityEvent): void {
    const normalized = normalizeActivityEvent(event);
    const index = normalized.id ? this.at.get(normalized.id) : undefined;
    if (index !== undefined) {
      const prior = this.rows[index] as { kind: 'activity'; event: HarnessActivityEvent };
      this.rows[index] = { kind: 'activity', event: mergeActivity(prior.event, normalized) };
      return;
    }
    if (normalized.id) this.at.set(normalized.id, this.rows.length);
    this.rows.push({ kind: 'activity', event: normalized });
  }
}

const textOf = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => { const block = record(part); return block?.type === 'text' && typeof block.text === 'string' ? block.text : ''; }).join('');
};

/** A Claude Code sub-agent transcript (`subagents/agent-<id>.jsonl`): the same
 * records as its stream-json, one per line. Lines that are not JSON, or are
 * bookkeeping (`attachment`, ...), say nothing. A call with no result yet is
 * left running; the caller closes it `stopped` when the agent is not. */
export function claudeTranscriptRows(jsonl: string): SubAgentRow[] {
  const rows = new Rows();
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let value: Json | undefined;
    try { value = record(JSON.parse(line)); } catch { continue; }
    const message = record(value?.message);
    const content = message?.content;
    if (value?.type === 'user') {
      if (typeof content === 'string') { rows.prompt(content); continue; }
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        const block = record(part);
        if (block?.type === 'text' && typeof block.text === 'string') rows.prompt(block.text);
        if (block?.type !== 'tool_result') continue;
        const output = textOf(block.content).split('\n').filter(Boolean);
        rows.activity({
          kind: block.is_error === true ? 'tool-error' : 'tool-done', label: 'tool',
          ...(typeof block.tool_use_id === 'string' ? { id: block.tool_use_id } : {}),
          ...(output.length ? { output } : {}),
        });
      }
    } else if (value?.type === 'assistant' && Array.isArray(content)) {
      for (const part of content) {
        const block = record(part);
        if (block?.type === 'text' && typeof block.text === 'string') rows.text(block.text);
        else if (block?.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim()) rows.activity({ kind: 'thinking', label: thoughtLabel(block.thinking), id: `thinking:${String(message?.id ?? rows.rows.length)}:${rows.rows.length}` });
        else if (block?.type === 'tool_use') {
          const name = String(block.name ?? 'tool');
          rows.activity({ kind: 'tool-start', ...toolFacts(name, record(block.input), ''), call: toolCall(name, record(block.input)), ...(typeof block.id === 'string' ? { id: block.id } : {}) });
        }
      }
    }
  }
  return rows.rows;
}

/** Where a Claude Code profile keeps the sub-agents of one session. */
function claudeSubagentDirs(workspace: string, sessionId: string, profile: string | undefined): string[] {
  const root = join(profile?.trim() || process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude'), 'projects');
  return claudeProjectDirectoryNames(workspace).map((name) => join(root, name, sessionId, 'subagents'));
}

interface ClaudeSubagentFile { agentId: string; file: string; agentType?: string; description?: string }

/** The transcript of the sub-agent a `Task` call (`parentCallId`) started: the
 * sidecar `agent-<id>.meta.json` names the call it belongs to (`toolUseId`). */
export async function findClaudeSubagent(workspace: string, sessionId: string, parentCallId: string, profile?: string): Promise<ClaudeSubagentFile | undefined> {
  for (const dir of claudeSubagentDirs(workspace, sessionId, profile)) {
    const names = await readdir(dir).catch(() => [] as string[]);
    for (const name of names.filter((entry) => entry.endsWith('.meta.json'))) {
      const meta = record(await readFile(join(dir, name), 'utf8').then(JSON.parse).catch(() => undefined));
      if (meta?.toolUseId !== parentCallId) continue;
      const stem = name.slice(0, -'.meta.json'.length);
      return {
        agentId: stem.replace(/^agent-/, ''), file: join(dir, `${stem}.jsonl`),
        ...(typeof meta.agentType === 'string' ? { agentType: meta.agentType } : {}),
        ...(typeof meta.description === 'string' ? { description: meta.description } : {}),
      };
    }
  }
  return undefined;
}

/** The rows of a Claude Code sub-agent, from the transcript on disk. */
export async function readClaudeSubagent(workspace: string, sessionId: string, parentCallId: string, profile?: string): Promise<{ agentId: string; rows: SubAgentRow[] } | undefined> {
  const found = await findClaudeSubagent(workspace, sessionId, parentCallId, profile);
  const text = found ? await readFile(found.file, 'utf8').catch(() => undefined) : undefined;
  return found && text !== undefined ? { agentId: found.agentId, rows: claudeTranscriptRows(text) } : undefined;
}

/** The live frames: the sub-agent's calls so far, from events that carry its
 * row id as `parentId` (any harness that publishes child frames). */
export function liveSubAgentRows(events: readonly HarnessActivityEvent[], parentId: string): SubAgentRow[] {
  const rows = new Rows();
  for (const event of events) if (event.parentId === parentId) rows.activity(event);
  return rows.rows;
}
