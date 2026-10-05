/** Gemini CLI: `<GEMINI_CLI_HOME>/.gemini/tmp/<project>/chats/session-<when>-<short>.jsonl`.
 *
 * Project-scoped by the workspace's own directory NAME, and the filename
 * carries a timestamp plus only the first eight characters of the session id
 * -- the full id is the `sessionId` on the file's first line. Observed on
 * disk:
 *   session-2026-09-22T12-31-8ac6abf2.jsonl
 *   {"sessionId":"8ac6abf2-ff23-4cb1-ab85-170400a022f1","projectHash":...}
 *
 * So the short id narrows the candidates and the first line confirms one,
 * rather than trusting an eight-character prefix on its own. The project
 * directory is not assumed either: every project under tmp/ is searched, which
 * costs a readdir and avoids guessing how a cwd becomes a directory name.
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rmdir, stat, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { CanonicalRecord, CanonicalToolCall } from '../../canonical.js';
import {
  nativeDataRoot, type NativeSessionEnvironment, type NativeSessionFile, type NativeSessionStore, type NativeThreadWriter,
} from '../stores.js';
import {
  absolutePath, assistantSteps, callCommand, callPath, callResultText, inputString, isWriteCall, requestText,
  sequentialIds, testedVersion, writeFileAtomic,
} from './thread-writer-files.js';

/** The first line only: these files grow to megabytes and the id is on line 1. */
async function firstLine(path: string): Promise<string> {
  return new Promise((resolve) => {
    const stream = createReadStream(path, { encoding: 'utf8', start: 0, end: 4096 });
    let data = '';
    stream.on('data', (chunk) => { data += chunk; });
    stream.on('error', () => resolve(''));
    stream.on('close', () => resolve(data.split('\n', 1)[0] ?? ''));
  });
}

async function holdsSession(path: string, nativeId: string): Promise<boolean> {
  try { return (JSON.parse(await firstLine(path)) as { sessionId?: string }).sessionId === nativeId; } catch { return false; }
}

function geminiRoot(environment: NativeSessionEnvironment): string {
  return join(nativeDataRoot(environment, 'GEMINI_CLI_HOME', homedir()), '.gemini', 'tmp');
}

/** Gemini CLI's own tool for a call (its 0.62 declarations):
 *  run_shell_command, read_file, replace, write_file, grep_search, glob,
 *  web_fetch, google_web_search. Anything else is told as text. */
function geminiCall(workspace: string) {
  return (call: CanonicalToolCall): { name: string; args: Record<string, unknown> } | undefined => {
    const path = callPath(call);
    const file = path ? absolutePath(workspace, path) : undefined;
    const name = call.name.toLowerCase();
    if (call.category === 'run' || (!call.category && /^(bash|shell|exec|run_shell_command|shell_command)$/.test(name))) {
      const command = callCommand(call);
      return command ? { name: 'run_shell_command', args: { command } } : undefined;
    }
    if (call.category === 'read' && file) return { name: 'read_file', args: { file_path: file } };
    if (call.category === 'edit' && file) {
      if (isWriteCall(call)) return { name: 'write_file', args: { file_path: file, content: inputString(call, 'content', 'file_text', 'text') ?? '' } };
      const oldString = inputString(call, 'old_string', 'oldText', 'old_str');
      const newString = inputString(call, 'new_string', 'newText', 'new_str');
      return oldString !== undefined && newString !== undefined
        ? { name: 'replace', args: { file_path: file, instruction: call.label, old_string: oldString, new_string: newString } } : undefined;
    }
    if (call.category === 'search') {
      const pattern = inputString(call, 'pattern', 'query', 'regex') ?? call.target;
      if (!pattern) return undefined;
      const where = inputString(call, 'path', 'dir_path', 'directory');
      const args = { pattern, ...(where ? { dir_path: absolutePath(workspace, where) } : {}) };
      return { name: /glob|find|list|ls/.test(name) ? 'glob' : 'grep_search', args };
    }
    if (call.category === 'fetch') {
      const url = inputString(call, 'url', 'uri');
      if (url) return { name: 'web_fetch', args: { prompt: url } };
      const query = inputString(call, 'query', 'q') ?? call.target;
      return query ? { name: 'google_web_search', args: { query } } : undefined;
    }
    return undefined;
  };
}

export interface GeminiThreadOptions {
  sessionId: string;
  workspace: string;
  model: string | null;
  now: Date;
  messageId?: () => string;
}

const ZERO_TOKENS = { input: 0, output: 0, cached: 0, thoughts: 0, tool: 0, total: 0 };

/** The thread as Gemini CLI 0.62 writes a chat: a metadata first line
 *  (sessionId, projectHash = sha256 of the cwd, startTime, lastUpdated,
 *  kind), then `user` records (content as parts) and `gemini` records
 *  (content as text, `toolCalls` each carrying its `functionResponse`
 *  result) -- the model's calls and their results are rebuilt from
 *  toolCalls on resume (convertSessionToClientHistory). Gemini itself also
 *  writes a `user` record holding the same functionResponse parts after each
 *  batch; that one is NOT written here: on resume it is replayed as well, and
 *  every result reached the model twice (seen against a local endpoint). No
 *  `$set` updates: the first line already holds the final metadata. */
export function geminiThreadLines(record: CanonicalRecord, options: GeminiThreadOptions): string {
  const messageId = options.messageId ?? randomUUID;
  const callId = sequentialIds('clikcode_call_');
  const start = options.now.getTime();
  let tick = 0;
  const stamp = (): string => new Date(start + (tick++)).toISOString();
  const records: Record<string, unknown>[] = [];
  const map = geminiCall(options.workspace);
  for (const turn of record.turns) {
    const request = requestText(turn);
    if (request.trim() || !records.length) {
      records.push({ id: messageId(), timestamp: stamp(), type: 'user', content: [{ text: request.trim() ? request : '(continue)' }] });
    }
    const model = turn.origin.model ?? options.model ?? 'unknown';
    for (const step of assistantSteps(turn, map, callId)) {
      const at = stamp();
      const calls = step.calls.map((call) => {
        const output = callResultText(call.call);
        return {
          output,
          record: {
            id: call.id, name: call.name, args: call.args,
            result: [{ functionResponse: { id: call.id, name: call.name, response: { output } } }],
            status: call.call.status === 'done' ? 'success' : 'error', timestamp: at, resultDisplay: output,
          },
        };
      });
      records.push({
        id: messageId(), timestamp: at, type: 'gemini', content: step.text, thoughts: [], tokens: ZERO_TOKENS, model,
        ...(calls.length ? { toolCalls: calls.map((call) => call.record) } : {}),
      });
    }
  }
  const first = {
    sessionId: options.sessionId, projectHash: createHash('sha256').update(options.workspace).digest('hex'),
    startTime: options.now.toISOString(), lastUpdated: new Date(start + Math.max(0, tick - 1)).toISOString(), kind: 'main',
  };
  return `${[first, ...records].map((line) => JSON.stringify(line)).join('\n')}\n`;
}

/** Gemini's own project slug (packages/core/src/config/projectRegistry.ts
 *  slugify): the folder's basename, lowercased, every non-alphanumeric a
 *  dash, runs collapsed, ends trimmed. */
export function geminiProjectSlug(workspace: string): string {
  return basename(workspace).toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'project';
}

async function ownerOf(marker: string): Promise<string | undefined> {
  return readFile(marker, 'utf8').then((text) => resolve(text.trim()), () => undefined);
}

/** The project directory name under `<GEMINI_CLI_HOME>/.gemini/tmp` that
 *  Gemini uses for `workspace`, registering it exactly as Gemini's
 *  ProjectRegistry.getShortId would when the profile has never run there:
 *  `projects.json` maps the path to a slug, and `tmp/<slug>/.project_root`
 *  plus `history/<slug>/.project_root` hold the owning path. Taken under
 *  Gemini's own lock (proper-lockfile: a `projects.json.lock` directory).
 *  Undefined -- the writer declines -- for anything unexpected: an
 *  unreadable registry, a held lock, a slug owned elsewhere. */
async function geminiProjectDirectory(geminiDirectory: string, workspace: string): Promise<string | undefined> {
  const path = resolve(workspace);
  const registryPath = join(geminiDirectory, 'projects.json');
  const bases = [join(geminiDirectory, 'tmp'), join(geminiDirectory, 'history')];
  await mkdir(geminiDirectory, { recursive: true });
  const lock = `${registryPath}.lock`;
  try { await mkdir(lock); } catch { return undefined; }
  try {
    const text = await readFile(registryPath, 'utf8').catch((error: NodeJS.ErrnoException) => (error.code === 'ENOENT' ? '{"projects":{}}' : undefined));
    if (text === undefined) return undefined;
    const registry = JSON.parse(text) as { projects?: Record<string, string> };
    if (!registry || typeof registry.projects !== 'object' || registry.projects === null) return undefined;
    const projects = registry.projects;
    let slug = projects[path];
    if (slug && !/^[a-z0-9-]+$/.test(slug)) return undefined;
    if (!slug) {
      const taken = new Set(Object.values(projects));
      for (let counter = 0; counter < 1000 && !slug; counter += 1) {
        const candidate = counter ? `${geminiProjectSlug(path)}-${counter}` : geminiProjectSlug(path);
        if (taken.has(candidate)) continue;
        const owners = await Promise.all(bases.map((base) => ownerOf(join(base, candidate, '.project_root'))));
        if (owners.every((owner) => owner === undefined || owner === path)) slug = candidate;
      }
      if (!slug) return undefined;
      projects[path] = slug;
      await writeFileAtomic(registryPath, JSON.stringify({ ...registry, projects }, null, 2));
    }
    for (const base of bases) {
      const marker = join(base, slug, '.project_root');
      const owner = await ownerOf(marker);
      if (owner !== undefined && owner !== path) return undefined;
      if (owner === undefined) {
        await mkdir(dirname(marker), { recursive: true });
        await writeFile(marker, path, { encoding: 'utf8', flag: 'wx' });
      }
    }
    return join(bases[0]!, slug);
  } finally {
    await rmdir(lock).catch(() => undefined);
  }
}

/** NOT enabled: no build is verified, so every write is declined and the
 *  conversation is transferred as a prompt.
 *
 *  What was seen against Gemini CLI 0.62.0 (2026-10-04, vendor-sandbox, a
 *  local Gemini-API endpoint through GOOGLE_GEMINI_BASE_URL -- Google
 *  sign-in fails outside the real home, so no real model was reachable):
 *  a thread written here is listed by `gemini --list-sessions`, and
 *  `gemini --resume <id> --prompt ...` sent the whole written history,
 *  calls and results once each, to the model.
 *
 *  What blocks enabling it: ClikCode resumes Gemini over ACP, and 0.62.0's
 *  ACP `session/load` races with itself. Loading starts the chat recorder
 *  for the requested id, which appends a fresh header plus a `$set` of the
 *  messages to [session context] to the very file being loaded; when that
 *  lands before the session list is read (it did on every plain run), the
 *  thread reads as empty and load fails with "No previous sessions found for
 *  this project". A session Gemini's own CLI wrote fails the same way, so
 *  this is not the format. The CLI turn cannot resume by id either
 *  (`--session-id` refuses an existing id). Enable -- list the build in
 *  `testedVersions` and gate on it -- once a resume through ClikCode's own
 *  path is seen to work. */
export const geminiThreadWriter: NativeThreadWriter = {
  testedVersions: [],
  versionOk: testedVersion([]),
  async write(record, context) {
    if (!record.turns.length) return undefined;
    const geminiDirectory = dirname(geminiRoot(context.environment));
    const project = await geminiProjectDirectory(geminiDirectory, context.workspace);
    if (!project) return undefined;
    const sessionId = randomUUID();
    const now = new Date();
    const name = `session-${now.toISOString().slice(0, 16).replace(/:/g, '-')}-${sessionId.slice(0, 8)}.jsonl`;
    await writeFileAtomic(join(project, 'chats', name), geminiThreadLines(record, {
      sessionId, workspace: resolve(context.workspace), model: context.model, now,
    }));
    return { nativeId: sessionId };
  },
};

export const geminiSessionStore: NativeSessionStore = {
  root: geminiRoot,
  async locate(root: string, nativeId: string): Promise<NativeSessionFile | undefined> {
    const short = nativeId.split('-', 1)[0];
    const projects = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const project of projects) {
      if (!project.isDirectory()) continue;
      const chats = join(root, project.name, 'chats');
      const files = await readdir(chats).catch(() => []);
      for (const name of files) {
        if (!name.endsWith('.jsonl') || (short && !name.includes(short))) continue;
        const path = join(chats, name);
        if (await stat(path).then(() => true, () => false) && await holdsSession(path, nativeId)) return { path, root };
      }
    }
    return undefined;
  },
  writer: geminiThreadWriter,
};
