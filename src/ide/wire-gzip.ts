/** Long lines of the bridge over SSH, gzipped.
 *
 * A chat opened on another machine is megabytes of JSON text, and the link
 * (SSH through a loaded Mac) moves ~1-2 MB/s whatever `ssh -o Compression`
 * says -- measured: the same 8 MB took 4.8 s with it on and off, and 1.4 s
 * gzipped first. The relay (bridge-stdio.ts) sends a line longer than
 * MIN_BYTES as `{"type":"z","data":"<base64 gzip of the line>"}`, and only to
 * a client that asked (`CLIKCODE_WIRE_GZIP=1` in the command it started): one
 * that does not know `z` would drop the line. Short lines -- every keystroke,
 * every delta -- pass as they were. */
import { gunzipSync, gzipSync } from 'node:zlib';

export const WIRE_GZIP_ENV = 'CLIKCODE_WIRE_GZIP';
const MIN_BYTES = 32 * 1024;
const PREFIX = '{"type":"z","data":"';

/** `text` as one line to write: itself, or its gzipped form when long and the client asked. */
export function encodeWireLine(text: string, enabled: boolean): string {
  if (!enabled || text.length < MIN_BYTES) return text;
  return `${PREFIX}${gzipSync(text, { level: 1 }).toString('base64')}"}`;
}

/** The line a client was sent, as the relay's bridge wrote it. */
export function decodeWireLine(line: string): string {
  if (!line.startsWith(PREFIX)) return line;
  const data = (JSON.parse(line) as { data?: unknown }).data;
  return typeof data === 'string' ? gunzipSync(Buffer.from(data, 'base64')).toString('utf8') : line;
}
