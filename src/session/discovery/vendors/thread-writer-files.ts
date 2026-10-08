/** What the direct-file thread writers (Pi, Command Code, Qwen, Gemini CLI,
 * Copilot CLI, Aider) share: version gating, an atomic write, and how a
 * canonical call reads as arguments, as its result, or -- where the vendor
 * has no tool for it -- as text.
 *
 * Each vendor's own layout stays in its store file; this holds only what
 * would otherwise be copied six times. */

import { randomBytes } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { withProviderNote, type CanonicalToolCall, type CanonicalTurn } from '../../canonical.js';
import type { NativeThreadWriteContext } from '../stores.js';

/** `0.87.0` out of whatever first line a vendor's `--version` prints
 * (`GitHub Copilot CLI 1.0.91.`, `aider 0.86.2`). */
export function versionNumber(version: string | undefined): string | undefined {
  return /(\d+\.\d+\.\d+)/.exec(version ?? '')?.[1];
}

/** `2.1` out of `2.1.289`: the release line a build belongs to. */
function releaseLine(version: string): string {
  return version.split('.').slice(0, 2).map(Number).join('.');
}

/** True for an installed build on the release line of one in `tested`; an
 * unreadable version is not a tested one. Vendors ship patch builds almost
 * daily and none has changed how it stores a thread, so pinning the exact
 * build turned native threads off within a day of each verification (Claude
 * Code 2.1.289, agy 1.2.17) and every handoff fell back to the retelling. A
 * thread a newer build cannot resume is still caught: the vendor refuses it
 * and the turn retells (native-thread-invalid). */
export function testedVersion(tested: readonly string[]): (context: Pick<NativeThreadWriteContext, 'version'>) => boolean {
  const lines = new Set(tested.map((build) => versionNumber(build)).filter((build): build is string => Boolean(build)).map(releaseLine));
  return (context) => {
    const installed = versionNumber(context.version);
    return Boolean(installed && lines.has(releaseLine(installed)));
  };
}

/** Writes `content` at `path` through a temporary sibling and a rename, so
 * a reader never sees half a thread. Parent directories are created. */
export async function writeFileAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/** The request as the vendor's user message: the provider note at a
 * boundary, the text, then the files it attached, by path. */
export function requestText(turn: CanonicalTurn): string {
  const attached = turn.attachments.length ? `\n\nAttached files:\n${turn.attachments.map((path) => `- ${path}`).join('\n')}` : '';
  return withProviderNote(turn, `${turn.user}${attached}`);
}

/** Whether a call wrote a whole file rather than editing one in place. */
export function isWriteCall(call: CanonicalToolCall): boolean {
  return /^(write|create|write_file|create_file|writefile)$/i.test(call.name)
    || Boolean(call.diff?.some((file) => file.change === 'add'));
}

/** The first string among `keys` in the recorded arguments. */
export function inputString(call: CanonicalToolCall, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = call.input?.[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

/** `path` made absolute against the workspace, for vendors whose file tools
 * take absolute paths only. */
export function absolutePath(workspace: string, path: string): string {
  return isAbsolute(path) ? path : join(workspace, path);
}

/** One argument for a shell command line, quoted only when it needs it. */
export function shellQuote(value: string): string {
  return /^[\w./@%+=:,-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The path a file call acted on. */
export function callPath(call: CanonicalToolCall): string | undefined {
  return inputString(call, 'file_path', 'path', 'filePath', 'absolute_path', 'filename', 'file')
    ?? call.files[0] ?? call.target;
}

/** The command a shell call ran. */
export function callCommand(call: CanonicalToolCall): string | undefined {
  const command = call.input?.command;
  if (Array.isArray(command)) {
    const argv = command.map(String);
    // Codex's `["bash", "-lc", "<script>"]`: the script is the command.
    if (argv.length === 3 && /(^|\/)(ba|z)?sh$/.test(argv[0]!) && /^-l?c$/.test(argv[1]!)) return argv[2];
    return argv.join(' ');
  }
  return inputString(call, 'command', 'cmd') ?? call.target;
}

/** A call's diff as unified-diff-ish text, for a result the model reads. */
export function diffText(call: CanonicalToolCall): string {
  return (call.diff ?? []).map((file) => {
    const body = file.lines.map((line) => (
      line.kind === 'added' ? `+${line.text}` : line.kind === 'removed' ? `-${line.text}` : line.kind === 'gap' ? '@@' : ` ${line.text}`)).join('\n');
    const omitted = file.omitted ? `\n(${file.omitted} more diff lines not kept)` : '';
    return `${file.path ? `--- ${file.path}\n` : ''}${body}${omitted}`;
  }).join('\n');
}

/** What a call returned, as the text of its result. */
export function callResultText(call: CanonicalToolCall): string {
  const lines: string[] = [];
  if (call.output?.length) {
    if (call.outputTail && call.outputOmitted) lines.push(`(${call.outputOmitted} earlier lines not kept)`);
    lines.push(...call.output);
    if (!call.outputTail && call.outputOmitted) lines.push(`(${call.outputOmitted} more lines not kept)`);
  } else if (call.diff?.length) {
    lines.push(diffText(call));
  }
  if (call.exitCode !== undefined && call.exitCode !== 0) lines.push(`(exit code ${call.exitCode})`);
  if (call.status === 'unfinished') lines.push('(this call did not finish; no result was recorded)');
  else if (call.status === 'failed' && (call.exitCode === undefined || call.exitCode === 0)) lines.push('(failed)');
  else if (!lines.length) lines.push('(done)');
  return lines.join('\n');
}

/** A call the vendor has no tool for, told as text in the answer. */
export function callAsText(call: CanonicalToolCall): string {
  const status = call.status === 'failed' ? ' (failed)' : call.status === 'unfinished' ? ' (unfinished)' : '';
  const result = callResultText(call);
  return `[${call.label}]${status}\n${result.split('\n').map((line) => `> ${line}`).join('\n')}`;
}

/** A call in the vendor's own terms. */
export interface VendorCall {
  call: CanonicalToolCall;
  /** The vendor's tool name. */
  name: string;
  args: Record<string, unknown>;
  /** A call id unique within the thread. */
  id: string;
}

/** One model response: its text, then the calls it made. */
export interface AssistantStep {
  text: string;
  calls: VendorCall[];
}

/** A turn's answer as the model responses a vendor stores: text and calls
 * in order, a new response after each batch of calls (their results go in
 * between). `map` names the vendor's own tool for a call, or undefined for a
 * call it has none for -- that one is told as text instead. */
export function assistantSteps(
  turn: CanonicalTurn,
  map: (call: CanonicalToolCall) => { name: string; args: Record<string, unknown> } | undefined,
  nextId: () => string,
): AssistantStep[] {
  const steps: AssistantStep[] = [];
  let step: AssistantStep | undefined;
  const addText = (text: string): void => {
    if (!text.trim()) return;
    if (!step || step.calls.length) { step = { text: '', calls: [] }; steps.push(step); }
    step.text = step.text ? `${step.text}\n\n${text.trim()}` : text.trim();
  };
  for (const part of turn.parts) {
    if (part.type === 'text') { addText(part.text); continue; }
    const mapped = map(part.call);
    if (!mapped) { addText(callAsText(part.call)); continue; }
    if (!step) { step = { text: '', calls: [] }; steps.push(step); }
    step.calls.push({ call: part.call, ...mapped, id: nextId() });
  }
  return steps;
}

/** A counter-backed id source, so a thread's ids are deterministic for a
 * given seed (tests pin them) and unique within it. */
export function sequentialIds(prefix: string): () => string {
  let next = 0;
  return () => `${prefix}${(next += 1).toString().padStart(4, '0')}`;
}
