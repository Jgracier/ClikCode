/** Which code chunks of earlier builds an install keeps beside the new one (scripts/install-local.mjs).
 *
 * The program is split into chunks (scripts/build.mjs) and a process loads a chunk when it first needs
 * it -- from the installed release folder, after a newer build has been swapped in. Chunk names carry
 * a hash of their content, so an older chunk never collides with a new one; it only has to still be
 * there. A chunk that left the build is kept while any ClikCode process that started before it left
 * is alive: such a process may still ask for it, however long it has been running (a window busy for
 * days never gives way to a newer build by itself). One that started after it left runs a build
 * without it. */
import { execFileSync } from 'node:child_process';

/** Grace after the moment a chunk left: a process that started just as the build was swapped may
 * still have resolved the old one, and `ps` counts in whole seconds. */
const SWAP_SLACK_MS = 60_000;

/** `previous`: the chunk names in the release being replaced. `next`: the new build's. `left`: when
 * each chunk already being carried left its build (the previous install's answer). `starts`: when each
 * live ClikCode process started; undefined when that cannot be known, and then nothing is dropped.
 * Returns the chunks to carry, each with when it left. */
export function chunksToCarry({ previous, next, left = {}, starts, now = Date.now() }) {
  const carry = {};
  for (const name of previous) {
    if (next.has(name)) continue;
    const leftAt = left[name] ?? now;
    if (!starts || starts.some((start) => start < leftAt + SWAP_SLACK_MS)) carry[name] = leftAt;
  }
  return carry;
}

/** `ps` elapsed time ([[dd-]hh:]mm:ss) in milliseconds. */
export function elapsedMs(text) {
  const [days, clock] = text.includes('-') ? text.split('-') : ['0', text];
  const parts = clock.split(':').map(Number);
  while (parts.length < 3) parts.unshift(0);
  const [hours, minutes, seconds] = parts;
  return ((Number(days) * 24 + hours) * 60 + minutes) * 60_000 + seconds * 1000;
}

/** When each running process whose command line names one of `paths` (the installed launcher, the
 * release folder) started; undefined where `ps` cannot say. */
export function liveStarts(paths, now = Date.now(), ps = () => execFileSync('ps', ['-axww', '-o', 'etime=,args='], { encoding: 'utf8' })) {
  let listing;
  try { listing = ps(); } catch { return undefined; }
  const starts = [];
  for (const line of listing.split('\n')) {
    const match = /^\s*(\S+)\s+(.*)$/.exec(line);
    if (match && paths.some((path) => match[2].includes(path))) starts.push(now - elapsedMs(match[1]));
  }
  return starts;
}
