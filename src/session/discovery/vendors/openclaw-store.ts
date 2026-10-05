/** OpenClaw: every session lives in SQLite
 *  (`<state dir>/agents/main/agent/openclaw-agent.sqlite`: transcript
 *  events plus a dozen derived index, identity and generation tables), so a
 *  thread is not written there directly. OpenClaw's own importer is used
 *  instead: the thread is written as a legacy file-backed session (a Pi
 *  transcript `<id>.jsonl` beside a `sessions.json` index, the layout OpenClaw
 *  used before SQLite) and `openclaw doctor --session-sqlite import` moves it
 *  in, validates every event, and archives the files.
 *
 * Observed (vendor-sandbox, OpenClaw 2026.9.6, a vLLM provider pointed at a
 * local stub that logged every request):
 *
 *   - `agent --local --session-id <id>` (how ClikCode resumes it) resumes the
 *     session stored under `agent:main:explicit:<id>` and sends its transcript
 *     to the model as history. Format version 4; the header's cwd is not
 *     used (OpenClaw runs in its own workspace).
 *   - The import takes the state ownership lock a running Gateway holds, so
 *     it fails while one runs -- a transfer. A Gateway refuses to start while
 *     legacy files are present, so they are removed whenever the import did
 *     not take them.
 *   - The import takes EVERY legacy source in the sessions directory; one
 *     already there is the user's to migrate, so the writer then declines.
 *   - A run leaves a manifest under `session-sqlite-migration-runs/` and the
 *     archived files under `agents/main/session-sqlite-import-archive/`:
 *     OpenClaw's own receipts, kept.
 */

import { randomUUID } from 'node:crypto';
import { readdir, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { captureNativeHarnessOutput } from '../../../harness/transport/native/command.js';
import type { CanonicalToolCall } from '../../canonical.js';
import { type NativeSessionEnvironment, type NativeSessionStore, type NativeThreadWriter } from '../stores.js';
import { piCall, piThreadLines } from './pi-store.js';
import { testedVersion, writeFileAtomic } from './thread-writer-files.js';

/** The agent ClikCode runs (`agent --agent main`). */
const AGENT = 'main';

/** `OPENCLAW_STATE_DIR`, else `~/.openclaw`; undefined under a named
 *  profile or OPENCLAW_HOME, whose layouts were not observed. */
function openClawStateDir(environment: NativeSessionEnvironment): string | undefined {
  if (environment.OPENCLAW_PROFILE?.trim() || environment.OPENCLAW_HOME?.trim()) return undefined;
  return environment.OPENCLAW_STATE_DIR?.trim() || join(environment.HOME?.trim() || homedir(), '.openclaw');
}

/** OpenClaw's tools (exec, read, edit, write, ls): Pi's, with `exec` for the
 *  shell and `ls` for a listing. */
export function openClawCall(call: CanonicalToolCall): { name: string; args: Record<string, unknown> } | undefined {
  const mapped = piCall(call);
  if (mapped?.name === 'bash') return { name: 'exec', args: mapped.args };
  if (mapped) return mapped;
  if (call.category === 'search' && /^(ls|list|list_dir|list_directory)$/i.test(call.name)) {
    const path = typeof call.input?.path === 'string' ? call.input.path : call.target;
    return { name: 'ls', args: path ? { path } : {} };
  }
  return undefined;
}

interface ImportReport {
  targets?: { agentId?: string; storePath?: string; importedEntries?: number; importedTranscriptEvents?: number; issues?: unknown[] }[];
}

/** Verified against OpenClaw 2026.9.6: see the module comment; live proof in
 *  the commit that added this. */
export const openClawThreadWriter: NativeThreadWriter = {
  testedVersions: ['2026.9.6'],
  versionOk: testedVersion(['2026.9.6']),
  async write(record, context) {
    if (!record.turns.length) return undefined;
    const stateDir = openClawStateDir(context.environment);
    if (!stateDir) return undefined;
    // No database = OpenClaw never ran here (no onboarding, no model).
    if (!(await stat(join(stateDir, 'agents', AGENT, 'agent', 'openclaw-agent.sqlite')).then((s) => s.isFile(), () => false))) return undefined;
    const sessions = join(stateDir, 'agents', AGENT, 'sessions');
    const existing = await readdir(sessions).catch(() => [] as string[]);
    if (existing.some((name) => name === 'sessions.json' || name.endsWith('.jsonl'))) return undefined;

    const sessionId = randomUUID();
    const now = new Date();
    const transcript = join(sessions, `${sessionId}.jsonl`);
    const index = join(sessions, 'sessions.json');
    const text = piThreadLines(record, { sessionId, workspace: context.workspace, model: context.model, now, mapCall: openClawCall, version: 4 });
    const events = text.trimEnd().split('\n').length;
    try {
      await writeFileAtomic(transcript, text);
      await writeFileAtomic(index, `${JSON.stringify({
        [`agent:${AGENT}:explicit:${sessionId}`]: { sessionId, updatedAt: now.getTime(), sessionFile: transcript },
      }, null, 2)}\n`);
      const output = await captureNativeHarnessOutput(
        context.harness, ['doctor', '--session-sqlite', 'import', '--session-sqlite-agent', AGENT, '--json'],
        context.environment, 60_000, context.workspace,
      );
      const report = JSON.parse(output.slice(output.indexOf('{'))) as ImportReport;
      const target = report.targets?.find((item) => item.agentId === AGENT);
      if (target?.storePath !== index || target.importedEntries !== 1 || target.importedTranscriptEvents !== events || target.issues?.length) {
        throw new Error('import did not take the thread');
      }
      return { nativeId: sessionId };
    } catch {
      // fail-open-ok: a transfer follows; legacy files left behind would
      // stop a Gateway from starting.
      await rm(transcript, { force: true }).catch(() => undefined);
      await rm(index, { force: true }).catch(() => undefined);
      return undefined;
    }
  },
};

export const openClawSessionStore: NativeSessionStore = {
  root: openClawStateDir,
  writer: openClawThreadWriter,
};
