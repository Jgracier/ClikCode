/** Harness-protocol classification and parsing -- the router runtime
 * bridge, capability checks, and per-vendor turn/activity-event parsing.
 * Everything here is pure request/response shaping: given a harness
 * definition and some raw text a vendor CLI produced, what does it mean?
 * No session/account state, no I/O beyond the router runtime require. */

import chalk from 'chalk';
import { visibleSlice } from './markdown-render.js';
import { homedir } from 'node:os';
import { localHarnessForCommand } from './harness-runtime.js';
export { nativeResponseUpdate, type NativeResponseUpdate } from './harness-event-adapters.js';
import type {
  AiHarnessAccount, AiLocalHarnessDefinition,
  HarnessActivityEvent, HarnessSession,
} from './types.js';
export {
  harnessIntegrationLevel, harnessSupportsEffort, harnessSupportsImages, harnessSupportsPermissionMode,
  localHarnessCapabilityManifest, localHarnessForCommand, localHarnessForProvider, localRouter, streamLocalAiTurn,
} from './harness-runtime.js';

export function nativeSessionIds(outputText: string, format: 'json' | 'json-lines' | 'text' = 'text'): Set<string> {
  const explicitIds = new Set<string>();
  const genericIds = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (/^(?:session_?id|thread_?id|chat_?id|conversation_?id|session)$/i.test(key) && typeof child === 'string' && child.trim()) explicitIds.add(child.trim());
      else if (/^id$/i.test(key) && typeof child === 'string' && child.trim()) genericIds.add(child.trim());
      else visit(child);
    }
  };
  try {
    if (format === 'json') visit(JSON.parse(outputText));
    else if (format === 'json-lines') {
      for (const line of outputText.split(/\r?\n/).filter(Boolean)) visit(JSON.parse(line));
    }
  } catch {
    // A vendor changing its documented JSON shape must not make us attach a
    // guessed session. The stable textual identifiers below are still safe.
  }
  const ids = new Set<string>([...explicitIds, ...genericIds]);
  for (const match of outputText.matchAll(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi)) ids.add(match[0]);
  return ids;
}

export function nativeTurnResult(harness: AiLocalHarnessDefinition, stdout: string): { text: string; nativeSessionId?: string; isError?: boolean; statusCode?: number } {
  if (!harness.turn) throw new Error(`${harness.displayName} has no centralized turn adapter`);
  if (harness.turn.output === 'text') {
    const text = stdout.trim();
    if (!text) throw new Error(`${harness.displayName} returned no assistant text`);
    const nativeSessionId = /(?:session|thread|chat)(?:\s+id)?\s*[:=]\s*([\w-]{8,})/i.exec(stdout)?.[1];
    return { text, ...(nativeSessionId ? { nativeSessionId } : {}) };
  }
  const values: unknown[] = [];
  try {
    if (harness.turn.output === 'json') values.push(JSON.parse(stdout));
    else for (const line of stdout.split(/\r?\n/).filter((line) => line.trim())) values.push(JSON.parse(line));
  } catch (error) {
    throw new Error(`${harness.displayName} returned invalid ${harness.turn.output} output: ${(error as Error).message}`);
  }
  const fields = new Set(harness.turn.responseFields ?? ['result', 'response', 'text', 'content']);
  const messages: string[] = [];
  let isError = false;
  let statusCode: number | undefined;
  // Distinct from `messages`: a string `error` field is a failure reason,
  // never the assistant's own reply, so it must never end up as the
  // returned "text" for a successful-looking turn -- but without capturing
  // it separately, a genuine failure with no text in any of `fields` (a
  // real, verified shape: Antigravity CLI's own {status:"ERROR",
  // error:"API error...", response:""}) surfaced only as a generic
  // "returned no assistant text", discarding the real reason entirely.
  let errorMessage: string | undefined;
  const visit = (value: unknown, parentType?: string): void => {
    if (Array.isArray(value)) return value.forEach((item) => visit(item, parentType));
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    const type = typeof record.type === 'string' ? record.type : parentType;
    // A failed tool/command item is not a failed turn. Codex's public JSONL
    // stream does not preserve the internal `source` field we previously
    // used to distinguish those cases: it emits an item.completed envelope
    // containing {type:"command_execution", status:"failed"}. Classify by
    // the event's semantic type instead, so a later agent_message remains a
    // successful answer. Untyped objects remain terminal because several
    // providers (verified with Antigravity) return a bare
    // {status:"ERROR", error:"...", response:""} result object.
    const terminalEnvelope = !type || /(?:^|[._-])(?:assistant|agent|message|result|response|turn|session|final)(?:$|[._-])/i.test(type);
    if (terminalEnvelope && (record.is_error === true || record.error === true || (typeof record.status === 'string' && /^(error|failed)$/i.test(record.status)))) isError = true;
    if (typeof record.api_error_status === 'number') statusCode = record.api_error_status;
    else if (typeof record.status === 'number' && record.status >= 400) statusCode = record.status;
    if (typeof record.error === 'string' && record.error.trim()) errorMessage = record.error.trim();
    for (const [key, child] of Object.entries(record)) {
      if (fields.has(key) && typeof child === 'string' && child.trim()) {
        // JSON event streams often contain tool input and user echoes. Only
        // accept generic text/content from assistant/result-shaped events.
        if (!['text', 'content'].includes(key) || !type || /assistant|agent|message|result|complete|text|say/i.test(type)) messages.push(child.trim());
      } else visit(child, type);
    }
  };
  values.forEach((value) => visit(value));
  // Gemini's stream-json terminal result contains statistics rather than a
  // repeated final response. Its assistant `message` records are genuine
  // incremental chunks, so reconstruct them in order instead of returning
  // only the final chunk collected by the generic structured-output walk.
  const geminiStreamText = harness.command === 'gemini'
    ? values.flatMap((value) => {
      if (!value || typeof value !== 'object') return [];
      const record = value as Record<string, unknown>;
      return record.type === 'message' && record.role === 'assistant' && typeof record.content === 'string'
        ? [record.content]
        : [];
    }).join('')
    : '';
  const gooseStreamText = harness.command === 'goose'
    ? values.flatMap((value) => {
      if (!value || typeof value !== 'object') return [];
      const record = value as Record<string, unknown>;
      const message = record.message && typeof record.message === 'object' ? record.message as Record<string, unknown> : undefined;
      if (record.type !== 'message' || message?.role !== 'assistant' || !Array.isArray(message.content)) return [];
      return message.content.flatMap((part) => part && typeof part === 'object'
        && (part as Record<string, unknown>).type === 'text' && typeof (part as Record<string, unknown>).text === 'string'
        ? [String((part as Record<string, unknown>).text)] : []);
    }).join('')
    : '';
  // Some harnesses report a bare string `error` without also setting an
  // is_error flag or top-level failed status. When no assistant message was
  // produced, that string is still a turn failure rather than a successful
  // reply. This matters now that process exit codes are only advisory: a
  // non-zero exit must not be the sole signal preserving this failure.
  if (messages.length === 0 && errorMessage) isError = true;
  // errorMessage only as a fallback, never preferred over real assistant
  // text -- a turn that produced actual output before failing partway
  // through should still show that output, not the failure reason instead
  // of it.
  const text = geminiStreamText.trim() || gooseStreamText.trim() || messages[messages.length - 1]?.trim() || errorMessage;
  if (!text) throw new Error(`${harness.displayName} returned no assistant text in its structured output`);
  const ids = nativeSessionIds(stdout, harness.turn.output);
  return { text, nativeSessionId: [...ids][0], ...(isError ? { isError } : {}), ...(statusCode ? { statusCode } : {}) };
}

/** Render provider JSONL as a small provider-neutral activity stream. */
/**
 * Every harness's own JSON envelope is a different shape (Codex's generic
 * `item.type` + `started`/`completed` states, Claude's `stream-json` content
 * array, opencode's top-level `type` with a `part` object) -- but what a user
 * actually needs to see collapses into the same handful of things happening:
 * the model is thinking, a tool started, a tool finished, or it's generating
 * the reply text. This is that common shape: each vendor's parser below maps
 * its own real, verified envelope into one of these, and exactly one
 * renderer (below) turns any of them into the same glyph/color/wording
 * regardless of which harness produced it -- a Codex tool call and a Claude
 * Code tool call read identically once they reach here.
 */

/** Line-capped, not byte-capped: a diff that's still readable at a glance
 * beats a byte-perfect one that pushes everything else out of the 5-line
 * activity window. */
export function capDiffLines(text: string, max: number): { lines: string[]; truncated: number } {
  const all = text.split(/\r?\n/);
  return { lines: all.slice(0, max), truncated: Math.max(0, all.length - max) };
}

function cappedActivityOutput(text: string): string[] | undefined {
  const normalized = text.trim();
  if (!normalized) return undefined;
  // Machine-readable tool output belongs to the native event protocol, not
  // the human transcript. Printing JSON/JSONL here was the reason a working
  // turn looked like a wall of tool-call envelopes until the final response
  // replaced it. Keep the useful tool label/status and omit its raw payload.
  const records = normalized.split(/\r?\n/).filter(Boolean);
  const isJson = (candidate: string): boolean => {
    if (!/^(?:\{|\[)/.test(candidate.trim())) return false;
    try { JSON.parse(candidate); return true; } catch { return false; }
  };
  if (isJson(normalized) || (records.length > 0 && records.every(isJson))) return undefined;
  const capped = capDiffLines(normalized, 3);
  return [...capped.lines, ...(capped.truncated ? [`… ${capped.truncated} more line${capped.truncated === 1 ? '' : 's'}`] : [])];
}

export function parseNativeActivityEvent(harness: AiLocalHarnessDefinition, lineText: string): HarnessActivityEvent | undefined {
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(lineText) as Record<string, unknown>;
  } catch {
    // fail-open-ok: plain-text harness output has no structured activity metadata to parse.
    return undefined;
  }
  const type = String(value.type ?? '');
  if (harness.command === 'antigravity' && value.event === 'step_update') {
    const step = value.step_update && typeof value.step_update === 'object' ? value.step_update as Record<string, unknown> : undefined;
    if (step?.step_type === 'tool') {
      return { kind: step.state === 'DONE' ? 'tool-done' : 'tool-start', label: String(step.tool_name ?? 'tool') };
    }
  }
  const item = value.item && typeof value.item === 'object' ? value.item as Record<string, unknown> : undefined;
  const itemType = String(item?.type ?? '');
  const reasoningSummary = (candidate: unknown): string | undefined => {
    if (typeof candidate === 'string') return candidate.trim() || undefined;
    if (!Array.isArray(candidate)) return undefined;
    const text = candidate.flatMap((part) => {
      if (typeof part === 'string') return [part];
      if (part && typeof part === 'object' && typeof (part as Record<string, unknown>).text === 'string') return [String((part as Record<string, unknown>).text)];
      return [];
    }).join(' ').trim();
    return text || undefined;
  };
  if (type === 'thread.started' || type === 'turn.started') return undefined;
  if (/reasoning|thinking/.test(itemType) && /completed|done/.test(type)) {
    const summary = reasoningSummary(item?.summary) ?? reasoningSummary(item?.text) ?? reasoningSummary(item?.content);
    return summary ? { kind: 'thinking', label: visibleSlice(summary.replace(/\s+/g, ' '), 140) } : undefined;
  }
  if (/command_execution/.test(itemType) && /started|completed/.test(type)) {
    const command = String(item?.command ?? item?.command_line ?? '').trim();
    if (!command) return undefined;
    const rawOutput = typeof item?.aggregated_output === 'string' ? item.aggregated_output
      : typeof item?.output === 'string' ? item.output : '';
    const output = cappedActivityOutput(rawOutput);
    return {
      kind: type.endsWith('completed') ? 'tool-done' : 'tool-start', label: command,
      ...(typeof item?.id === 'string' ? { id: item.id } : {}),
      ...(output?.length ? { output } : {}),
    };
  }
  if (/file_change/.test(itemType) && /started|completed/.test(type)) {
    return {
      kind: type.endsWith('completed') ? 'tool-done' : 'tool-start', label: 'files updated',
      ...(typeof item?.id === 'string' ? { id: item.id } : {}),
    };
  }
  if (/mcp_tool_call|tool_use|tool_call/.test(itemType) && /started|completed/.test(type)) {
    const name = String(item?.name ?? item?.server ?? 'tool');
    return {
      kind: type.endsWith('completed') ? 'tool-done' : 'tool-start', label: name,
      ...(typeof item?.id === 'string' ? { id: item.id } : {}),
    };
  }
  if (harness.command === 'claude') {
    if (type === 'system' && value.subtype === 'init') return undefined;
    if (type === 'assistant') {
      const message = value.message as { content?: Array<Record<string, unknown>> } | undefined;
      const tool = message?.content?.find((part) => part.type === 'tool_use');
      if (!tool) return undefined;
      const name = String(tool.name ?? 'tool');
      const input = tool.input && typeof tool.input === 'object' ? tool.input as Record<string, unknown> : undefined;
      // Verified against this exact session's own transcript: Edit's
      // input carries old_string/new_string verbatim, Write carries the
      // full new file as `content` with no prior text to diff against.
      // Capped to 4 lines a side -- the 5-line activity window can't show
      // more anyway, and a truncation count beats a silently-scrolled-off
      // tail.
      if (name === 'Edit' && typeof input?.old_string === 'string' && typeof input?.new_string === 'string') {
        const removed = capDiffLines(input.old_string, 4);
        const added = capDiffLines(input.new_string, 4);
        return {
          kind: 'tool-start', label: name,
          ...(typeof tool.id === 'string' ? { id: tool.id } : {}),
          diff: {
            removed: [...removed.lines, ...(removed.truncated ? [`… ${removed.truncated} more line${removed.truncated === 1 ? '' : 's'}`] : [])],
            added: [...added.lines, ...(added.truncated ? [`… ${added.truncated} more line${added.truncated === 1 ? '' : 's'}`] : [])],
          },
        };
      }
      if (name === 'Write' && typeof input?.content === 'string') {
        const added = capDiffLines(input.content, 4);
        return { kind: 'tool-start', label: name, ...(typeof tool.id === 'string' ? { id: tool.id } : {}), diff: { removed: [], added: [...added.lines, ...(added.truncated ? [`… ${added.truncated} more line${added.truncated === 1 ? '' : 's'}`] : [])] } };
      }
      return { kind: 'tool-start', label: name, ...(typeof tool.id === 'string' ? { id: tool.id } : {}) };
    }
    if (type === 'user') {
      const message = value.message as { content?: Array<Record<string, unknown>> } | undefined;
      const result = message?.content?.find((part) => part.type === 'tool_result');
      if (!result) return undefined;
      const content = typeof result.content === 'string' ? result.content : Array.isArray(result.content)
        ? result.content.flatMap((part) => part && typeof part === 'object' && typeof (part as Record<string, unknown>).text === 'string'
          ? [String((part as Record<string, unknown>).text)] : []).join('\n') : '';
      const output = cappedActivityOutput(content);
      return {
        kind: 'tool-done', label: 'tool',
        ...(typeof result.tool_use_id === 'string' ? { id: result.tool_use_id } : {}),
        ...(output?.length ? { output } : {}),
      };
    }
  }
  // opencode's own envelope is a different shape entirely: a top-level `type`
  // (not nested under `item`) and a `part` object instead of an `item` one.
  // Verified against a real `opencode run --format json` turn, including one
  // that actually called a tool — `part.tool` is the tool name and
  // `part.state.status` tracks completion.
  if (harness.command === 'opencode' && type === 'tool_use') {
    const part = value.part && typeof value.part === 'object' ? value.part as Record<string, unknown> : undefined;
    const state = part?.state && typeof part.state === 'object' ? part.state as Record<string, unknown> : undefined;
    const name = String(part?.tool ?? 'tool');
    return { kind: state?.status === 'completed' ? 'tool-done' : 'tool-start', label: name };
  }
  // Command Code's envelope wraps each lifecycle event under a top-level
  // `{ type: 'event', event: {...} }` (distinct from its `{ type: 'result' }`
  // terminal frame) -- verified against its own docs, though only the
  // `tool_running` value itself was confirmed there, not a paired
  // completion event, so this only ever reports 'tool-start'.
  if (harness.command === 'command' && type === 'event') {
    const inner = value.event && typeof value.event === 'object' ? value.event as Record<string, unknown> : undefined;
    if (inner?.type === 'tool_running') return { kind: 'tool-start', label: String(inner.toolName ?? 'tool') };
  }
  // Pi's own envelope: a flat `{ type: 'toolcall_start', toolName }` --
  // verified from its own docs (packages/coding-agent/docs/json.md), but
  // the docs excerpt available didn't name a paired completion event, so
  // (same as Command Code above) this only ever reports 'tool-start'.
  if (harness.command === 'pi') {
    if (type === 'tool_execution_start') return { kind: 'tool-start', label: String(value.toolName ?? 'tool') };
    if (type === 'tool_execution_end') return { kind: 'tool-done', label: String(value.toolName ?? 'tool') };
    if (type === 'message_update') {
      const event = value.assistantMessageEvent && typeof value.assistantMessageEvent === 'object'
        ? value.assistantMessageEvent as Record<string, unknown> : undefined;
      if (event?.type === 'toolcall_start') return { kind: 'tool-start', label: String(event.toolName ?? 'tool') };
    }
  }
  return undefined;
}

/** The one place that decides what a completed/in-progress tool call or a
 * thinking summary looks like in the persistent activity log -- every
 * harness's parser above feeds this same renderer, so the visual language
 * (glyph, color, wording) never drifts per-vendor. */
/** A code-change tool call (Edit/Write, or any other harness's own naming
 * for the same thing) gets its own color -- magenta -- distinct from a
 * generic tool call's yellow/green, the same way Claude Code's own UI
 * visually separates "a tool ran" from "a file changed" rather than
 * treating every tool call identically. Name-pattern matching (not just
 * `event.diff`'s presence) so this applies even for harnesses where the
 * diff content itself isn't available yet -- Codex's file_change events,
 * for instance, still get the distinct color even without line content. */
export function isCodeChangeLabel(label: string): boolean {
  return /^(edit|write|patch)$/i.test(label) || /file/i.test(label);
}

export function renderActivityLine(event: HarnessActivityEvent): string[] {
  if (event.kind === 'thinking') return [`  ${chalk.cyan('thinking')} ${chalk.dim(event.label)}`];
  const isCodeChange = Boolean(event.diff) || isCodeChangeLabel(event.label);
  const glyph = isCodeChange ? chalk.magenta('edit') : (event.kind === 'tool-done' ? chalk.green('done') : chalk.yellow('tool'));
  const summary = `  ${glyph} ${chalk.dim(event.label)}`;
  const detailLines = !event.diff ? (event.output ?? []).map((line) => `    ${chalk.dim(line)}`) : [
    ...event.diff.removed.map((line) => `    ${chalk.red(`- ${line}`)}`),
    ...event.diff.added.map((line) => `    ${chalk.green(`+ ${line}`)}`),
  ];
  const visible = detailLines.slice(0, 2);
  return [summary, ...visible, ...(detailLines.length > visible.length ? [`    ${chalk.dim(`… ${detailLines.length - visible.length} more`)}`] : [])];
}

/** Same idea for the spinner's own label: while a tool is actively running,
 * show what it's doing instead of a static "thinking" the whole time. */
export function renderActivityPhase(event: HarnessActivityEvent): string {
  if (event.kind === 'tool-start') return `running ${event.label}`;
  if (event.kind === 'thinking') return 'thinking';
  return 'generating response';
}

export function nativeActivityPhase(harness: AiLocalHarnessDefinition, lineText: string): 'generating response' | undefined {
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(lineText) as Record<string, unknown>;
  } catch {
    // fail-open-ok: non-JSON output is ordinary assistant text, not a structured result envelope.
    return undefined;
  }
  const type = String(value.type ?? '');
  const item = value.item && typeof value.item === 'object' ? value.item as Record<string, unknown> : undefined;
  const itemType = String(item?.type ?? '');
  if (harness.command === 'antigravity' && value.event === 'step_update') {
    const step = value.step_update && typeof value.step_update === 'object' ? value.step_update as Record<string, unknown> : undefined;
    if (step?.step_type === 'agent_response' && typeof step.text_delta === 'string') return 'generating response';
  }
  if (/assistant|agent_message/.test(itemType) && /started|delta|completed/.test(type)) return 'generating response';
  if (type === 'assistant') return 'generating response';
  if (harness.command === 'opencode' && type === 'text') return 'generating response';
  return undefined;
}

export function compactPath(path: string): string {
  const home = homedir();
  return path === home ? '~' : path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}

export function sessionProviderLabel(session: HarnessSession): string {
  if (session.route === 'gateway') return 'ClikDeploy Gateway';
  const harness = session.nativeHarness ? localHarnessForCommand(session.nativeHarness) : undefined;
  return harness?.displayName ?? session.provider ?? 'Not selected';
}

/** The one place that turns an account's nativeProfile into an actual
 * environment object -- every call site used to build `{ [env]: path }`
 * directly, nine of them, which meant nativeProfile.extraEnv (needed only
 * for Antigravity's ADC-based isolation) would have had to be added to all
 * nine individually, with a real risk of missing one and silently falling
 * back to shared, unisolated auth for just that one call path. */
export function nativeProfileEnvironment(nativeProfile: AiHarnessAccount['nativeProfile']): Record<string, string> {
  if (!nativeProfile) return {};
  return { [nativeProfile.env]: nativeProfile.path, ...nativeProfile.extraEnv };
}
