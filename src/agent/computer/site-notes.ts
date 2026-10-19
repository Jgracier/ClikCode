/** What an agent learned doing a task on a site (the URL that worked, the order of the screens, what was
 * missing), kept so the next run of the same task starts there instead of rediscovering it. Written by the
 * agent, shown again when a page on that host is opened. Never a place for keys or passwords. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { keyShaped } from './secret-finder.js';

const MAX_CHARS = 4_000;

function notesFile(stateDir: string, host: string): string {
  const safe = host.toLowerCase().replace(/^www\./, '').replace(/[^a-z0-9.-]/g, '_').slice(0, 100);
  if (!safe || safe.startsWith('.')) throw new Error('Notes need a site name such as app.asana.com.');
  return path.join(stateDir, 'computer', 'notes', `${safe}.md`);
}

export async function readSiteNotes(stateDir: string, host: string): Promise<string> {
  try { return (await fs.readFile(notesFile(stateDir, host), 'utf8')).trim(); } catch { return ''; }
}

/** Adds a note (newest last), keeping the newest MAX_CHARS. A note holding a key-like value is refused whole. */
export async function addSiteNote(stateDir: string, host: string, text: string): Promise<string> {
  const note = text.trim();
  if (!note) throw new Error('Notes need text to save.');
  if (note.split(/\s+/).some(word => keyShaped(word.replace(/^[("'`]+|[)"'`,.;]+$/g, '')))) throw new Error('Not saved: the note contains something shaped like a key or token. Notes are for steps and addresses, never secrets.');
  const file = notesFile(stateDir, host);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const all = `${await readSiteNotes(stateDir, host)}\n- ${note.replace(/\n+/g, ' ')}`.trim();
  const kept = all.length > MAX_CHARS ? `…${all.slice(-MAX_CHARS)}` : all;
  await fs.writeFile(file, `${kept}\n`, { mode: 0o600 });
  return kept;
}
