/** Large outputs remain accessible through the existing, session-confined
 * artifact directory instead of being silently discarded at the prompt cap. */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { toolOutputDir } from './security.js';

export async function retainToolOutput(output: string, cap: number, stateDir: string, sessionId: string, callId: string): Promise<string> {
  if (Buffer.byteLength(output) <= cap) return output;
  const dir = toolOutputDir(stateDir, sessionId);
  const file = join(dir, `${createHash('sha256').update(callId).update('\0').update(output).digest('hex').slice(0, 32)}.txt`);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  try { await writeFile(file, output, { encoding: 'utf8', mode: 0o600, flag: 'wx' }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const note = `\n[Full output saved at ${file}. Use read_file with offset/limit or grep on that file to inspect the omitted evidence.]`;
  const remaining = Math.max(0, cap - Buffer.byteLength(note) - 20);
  const bytes = Buffer.from(output);
  const head = bytes.subarray(0, Math.floor(remaining * 2 / 3)).toString('utf8').replace(/\uFFFD$/, '');
  const tail = bytes.subarray(bytes.length - Math.floor(remaining / 3)).toString('utf8').replace(/^\uFFFD+/, '');
  return `${head}\n[… omitted …]\n${tail}${note}`;
}
