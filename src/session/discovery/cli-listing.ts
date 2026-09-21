/** Asking a vendor's own CLI to list its sessions, and parsing whatever it
 * prints -- a table for some, structured output for others. */

import { captureNativeHarnessOutput } from '../../harness/transport/native/command.js';
import { inspectNativeHarness } from '../../harness/transport/native/inspect.js';
import type { AiLocalHarnessDefinition } from '../../harness/definition.js';
import { DiscoveredNativeSession } from './discovered-session.js';

function splitTableColumns(line: string): string[] {
  return line.trim().split(/ {2,}/).map((cell) => cell.trim());
}

/** Covers exactly the display formats actually observed from an installed
 * vendor table (opencode: a bare "11:16 AM" clock time for today; Hermes:
 * "yesterday" or a plain "2026-08-21" date) — not a general relative-date
 * parser. Anything else (a weekday name, "3 days ago", an "N ago" style)
 * returns undefined rather than a guessed value, since a wrong sort position
 * is worse than an honest "can't tell how recent this is". */
function parseDiscoveredTimestamp(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (lower === 'today') return startOfToday.getTime();
  if (lower === 'yesterday') return startOfToday.getTime() - 24 * 60 * 60 * 1000;
  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
    const parsed = Date.parse(trimmed);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  const clock = /^(\d{1,2}):(\d{2})\s*(am|pm)$/i.exec(trimmed);
  if (clock) {
    let hour = Number(clock[1]) % 12;
    if (clock[3].toLowerCase() === 'pm') hour += 12;
    return startOfToday.getTime() + hour * 60 * 60 * 1000 + Number(clock[2]) * 60 * 1000;
  }
  return undefined;
}

/** Vendor session-list output is a fixed-width table with vendor-chosen column
 * order (opencode puts the id first, Hermes puts it last) — reading the header
 * row to find each column by keyword instead of a hardcoded position is what
 * lets one parser cover every vendor's own layout without a per-vendor branch. */
function parseDiscoveredSessionsText(raw: string): DiscoveredNativeSession[] {
  const lines = raw.split(/\r?\n/).filter((line) => line.trim() && !/^[-─—\s]+$/.test(line));
  if (lines.length < 2) return [];
  const header = splitTableColumns(lines[0]).map((cell) => cell.toLowerCase());
  const idIndex = header.findIndex((cell) => cell === 'id' || cell.endsWith(' id'));
  if (idIndex === -1) return [];
  const titleIndex = header.findIndex((cell) => cell.includes('title') || cell.includes('name'));
  const updatedIndex = header.findIndex((cell) => cell.includes('updated') || cell.includes('active') || cell.includes('modified'));
  const sessions: DiscoveredNativeSession[] = [];
  for (const line of lines.slice(1)) {
    const cells = splitTableColumns(line);
    const nativeId = cells[idIndex];
    if (!nativeId || nativeId === '—' || nativeId === '-') continue;
    const updatedAt = updatedIndex >= 0 ? cells[updatedIndex] : undefined;
    sessions.push({
      nativeId,
      title: titleIndex >= 0 ? cells[titleIndex] : undefined,
      updatedAt,
      updatedAtMs: parseDiscoveredTimestamp(updatedAt),
    });
  }
  return sessions;
}

/** Field names come from two sources of different confidence: Qwen Code's own
 * docs give an exact schema (`sessionId`, `customTitle`, `mtime`/`startTime`)
 * confirmed against its README, and Crush's real Go source gives another
 * (`uuid` as the full resumable id, `id` as a 7-char display hash, `title`,
 * `modified`) confirmed against its repo — both are wired in by name.
 * Everything else here (goose, kilo) is an educated duck-type against common
 * conventions, never confirmed against a live install: a shape that doesn't
 * match one of these names contributes nothing rather than a guessed field. */
function parseDiscoveredSessionsStructured(raw: string, format: 'json' | 'json-lines'): DiscoveredNativeSession[] {
  const records: unknown[] = [];
  try {
    if (format === 'json-lines') {
      for (const line of raw.split(/\r?\n/)) { const trimmed = line.trim(); if (trimmed) records.push(JSON.parse(trimmed)); }
    } else {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) records.push(...parsed);
      else if (parsed && typeof parsed === 'object') {
        const container = Object.values(parsed as Record<string, unknown>).find((value) => Array.isArray(value));
        if (Array.isArray(container)) records.push(...container);
      }
    }
  } catch {
    // fail-open-ok: malformed optional session-list output cannot yield trustworthy resumable ids.
    return [];
  }
  const sessions: DiscoveredNativeSession[] = [];
  for (const record of records) {
    if (!record || typeof record !== 'object') continue;
    const item = record as Record<string, unknown>;
    // Crush's own `uuid` (the full resumable id) must win over its `id` (a
    // 7-char display-only hash) when both are present on the same record.
    const nativeId = item.uuid ?? item.id ?? item.sessionId ?? item.session_id ?? item.sessionID;
    if (typeof nativeId !== 'string' || !nativeId) continue;
    const title = item.customTitle ?? item.title ?? item.name ?? item.summary
      ?? (typeof item.prompt === 'string' ? item.prompt : undefined);
    const updatedAt = item.updatedAt ?? item.updated_at ?? item.modified ?? item.mtime ?? item.lastActive ?? item.startTime;
    sessions.push({
      nativeId,
      title: typeof title === 'string' ? title : undefined,
      updatedAt: typeof updatedAt === 'string' ? updatedAt : typeof updatedAt === 'number' ? new Date(updatedAt).toISOString() : undefined,
    });
  }
  return sessions;
}

/** Never installs anything for a passive scan (only harnesses already found on
 * PATH are queried), and never throws — a harness that isn't installed, has
 * no discovery command, or returns something this parser doesn't recognize
 * just contributes zero results instead of failing the whole picker. */
export async function discoverNativeSessions(
  harness: AiLocalHarnessDefinition, environment: Readonly<Record<string, string>>, workspace: string | undefined,
): Promise<DiscoveredNativeSession[]> {
  if (!harness.session?.discoverArgv) return [];
  const inspection = await inspectNativeHarness(harness, 800);
  if (!inspection.installed) return [];
  try {
    const raw = await captureNativeHarnessOutput(harness, harness.session.discoverArgv, environment, 4_000, workspace);
    const format = harness.session.discoverFormat ?? 'json';
    if (format === 'text') return parseDiscoveredSessionsText(raw);
    return parseDiscoveredSessionsStructured(raw, format);
  } catch {
    // fail-open-ok: passive discovery must not break the picker when an optional vendor command fails.
    return [];
  }
}
