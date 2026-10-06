/**
 * Every time, count, cost and path ClikCode shows, in one style for the
 * terminal and the VS Code webview. Chalk free and dependency free, so the
 * webview bundle can import it.
 */

/** A span as its two largest units: `[3, 'm', 5, 's']` for 3m 5s. */
function units(ms: number): [number, string, number, string] | [number, string] {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return [seconds, 's'];
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return [minutes, 'm', seconds % 60, 's'];
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? [hours, 'h', minutes % 60, 'm'] : [Math.floor(hours / 24), 'd', hours % 24, 'h'];
}

/** `42s`, `3m 5s`, `1h 15m`, `2d 3h`: a clock counting up -- the waiting
 * band's, a running call's, "Worked for …". */
export function formatElapsed(ms: number): string {
  const [major, majorUnit, minor, minorUnit] = units(ms);
  return minorUnit === undefined ? `${major}${majorUnit}` : `${major}${majorUnit} ${minor}${minorUnit}`;
}

/** A finished call's run time: `3.4s` under ten seconds, then as
 * {@link formatElapsed}. */
export function formatDuration(ms: number): string {
  return ms < 10_000 ? `${(Math.max(0, ms) / 1000).toFixed(1)}s` : formatElapsed(ms);
}

/** `45s`, `4m`, `2h 5m`, `1d 3h`: {@link formatElapsed} without the seconds
 * once there are minutes, for a row that shares its width. */
export function shortDuration(ms: number): string {
  const [major, majorUnit, minor, minorUnit] = units(ms);
  return minorUnit === undefined || minorUnit === 's' ? `${major}${majorUnit}` : `${major}${majorUnit} ${minor}${minorUnit}`;
}

/** `just now`, `4m ago`, `2h ago`, `3d ago`, then a date (`Oct 4`, with the
 * year when it is not this one). A conversation row shares its width with the
 * title, so a full locale timestamp does not fit. */
export function relativeTime(iso: string | undefined, now = Date.now()): string {
  if (!iso) return '';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const delta = Math.max(0, now - then);
  if (delta < 45_000) return 'just now';
  const minutes = Math.round(delta / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(delta / 3_600_000);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(delta / 86_400_000);
  if (days < 7) return `${days}d ago`;
  const date = new Date(then);
  return date.toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', ...(date.getFullYear() === new Date(now).getFullYear() ? {} : { year: 'numeric' }),
  });
}

/** `5:34PM`, or `5:34PM Friday Sep 25` when the reset is not today.
 *
 * The calendar day decides, not the window's name: a five-hour window that
 * rolls over after midnight needs its date as much as a weekly one does. */
export function quotaResetPhrase(reset: Date, now: number = Date.now()): string {
  const hours24 = reset.getHours();
  const time = `${hours24 % 12 || 12}:${reset.getMinutes().toString().padStart(2, '0')}${hours24 >= 12 ? 'PM' : 'AM'}`;
  const today = new Date(now);
  const sameDay = reset.getFullYear() === today.getFullYear()
    && reset.getMonth() === today.getMonth() && reset.getDate() === today.getDate();
  if (sameDay) return time;
  // Spelled out rather than taken from toLocaleDateString: that follows the
  // machine's locale, so the same reset reads "Sat 26 Sept" on one box and
  // "sam. 26 sept." on another, and a test written against either is wrong
  // somewhere else.
  const weekday = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][reset.getDay()];
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][reset.getMonth()];
  return `${time} ${weekday} ${month} ${reset.getDate()}`;
}

/** A count in a few characters: 999, 1.2k, 37k, 7.2M. A full comma-separated
 * count is what wrapped mid-number on a phone. */
export function compactCount(count: number): string {
  return count < 1000 ? String(count)
    : count < 1_000_000 ? `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k` : `${(count / 1_000_000).toFixed(1)}M`;
}

/** A cost or a balance: `$0.02`, or four places when cents would round it to
 * nothing (`$0.0031`). */
export function dollars(amount: number): string {
  return `$${amount !== 0 && Math.abs(amount) < 0.01 ? amount.toFixed(4) : amount.toFixed(2)}`;
}

/** A path under the home directory as `~/…`. Without `home` (the webview does
 * not know it) the usual home layouts are recognised instead. */
export function tildePath(path: string, home?: string): string {
  if (home === undefined) return path.replace(/^\/home\/[^/]+|^\/Users\/[^/]+|^[A-Z]:\\Users\\[^\\]+/, '~');
  if (path === home) return '~';
  return path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}
