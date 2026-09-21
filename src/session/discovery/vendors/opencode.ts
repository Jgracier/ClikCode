/** OpenCode's stored conversations. */

import { captureNativeHarnessOutput } from '../../../harness/transport/native/command.js';
import type { AiLocalHarnessDefinition } from '../../../harness/types.js';
import { ADOPTED_TRANSCRIPT_LIMIT } from '../transcript.js';

/** opencode publishes a real export command (`opencode export <sessionID>`,
 * confirmed live) that dumps the full session as JSON: a `messages` array of
 * `{info: {role}, parts: [{type, text}]}` entries. Only `type: "text"` parts
 * are used — tool calls and their results are real parts too but have no
 * plain-text representation in ClikCode's own {role, content: string}
 * message model, the same reason Claude/Codex transcripts above only keep
 * text blocks. */
export async function readOpencodeTranscript(harness: AiLocalHarnessDefinition, nativeId: string, workspace: string): Promise<Array<{ role: 'user' | 'assistant'; content: string }>> {
  let raw: string;
  try { raw = await captureNativeHarnessOutput(harness, ['export', nativeId], {}, 8_000, workspace); } catch {
    // fail-open-ok: session adoption is optional; a failed read-only vendor export has no importable messages.
    return [];
  }
  // `export` prints a human progress line ("Exporting session: <id>") before
  // the JSON body — skip to the first '{' rather than assume a fixed line count.
  const jsonStart = raw.indexOf('{');
  if (jsonStart === -1) return [];
  let parsed: { messages?: Array<{ info?: { role?: string }; parts?: Array<{ type?: string; text?: string }> }> };
  try { parsed = JSON.parse(raw.slice(jsonStart)); } catch {
    // fail-open-ok: malformed optional vendor export output cannot yield a trustworthy transcript.
    return [];
  }
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const message of parsed.messages ?? []) {
    const role = message.info?.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const text = (message.parts ?? []).filter((part) => part.type === 'text').map((part) => part.text ?? '').join(' ').trim();
    if (text) messages.push({ role, content: text });
  }
  return messages.slice(-ADOPTED_TRANSCRIPT_LIMIT);
}
