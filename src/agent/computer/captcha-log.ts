/** What each human check turned out to be and how it ended, one line per solver run, so the next family to work
 * on is read from what the connectors actually met, not guessed. Lines hold the site's host, the check's family,
 * the outcome and the time taken -- never page text, an answer or a secret. */
import fs from 'node:fs/promises';
import path from 'node:path';

export interface CaptchaRecord {
  at: string;
  /** The site the check was on (host only). */
  host: string;
  /** recaptcha, turnstile, hcaptcha, geetest, arkose, text, slider, hold, pow, or unknown. */
  family: string;
  /** cleared, still-there, puzzle or none. */
  outcome: string;
  seconds: number;
  /** How it was answered, in order (press, pictures, audio, drag ...); short words only. */
  steps: string[];
}

export function captchaLogPath(stateDir: string): string { return path.join(stateDir, 'computer', 'captcha-log.jsonl'); }

export async function recordCaptcha(stateDir: string, record: CaptchaRecord): Promise<void> {
  try {
    const file = captchaLogPath(stateDir);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.appendFile(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  } catch { /* a log that cannot be written never fails a sign-up */ }
}

export interface CaptchaTally { family: string; runs: number; cleared: number; seconds: number }

/** Runs and clears per family over the last `days`, most runs first. */
export async function captchaTally(stateDir: string, days = 30, now = Date.now()): Promise<CaptchaTally[]> {
  let text = '';
  try { text = await fs.readFile(captchaLogPath(stateDir), 'utf8'); } catch { return []; }
  const since = now - days * 86_400_000;
  const byFamily = new Map<string, CaptchaTally>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let record: CaptchaRecord;
    try { record = JSON.parse(line) as CaptchaRecord; } catch { continue; }
    if (!(Date.parse(record.at) >= since)) continue;
    const tally = byFamily.get(record.family) ?? { family: record.family, runs: 0, cleared: 0, seconds: 0 };
    tally.runs++; if (record.outcome === 'cleared') tally.cleared++; tally.seconds += record.seconds;
    byFamily.set(record.family, tally);
  }
  return [...byFamily.values()].sort((a, b) => b.runs - a.runs);
}

/** The short step word for a solver trace line. */
export function stepOf(traceLine: string): string | undefined {
  if (/^audio:/i.test(traceLine)) return 'audio';
  if (/^\d+ squares/i.test(traceLine)) return 'pictures';
  if (/GeeTest slide/i.test(traceLine)) return 'slide';
  if (/GeeTest board/i.test(traceLine)) return 'board';
  if (/GeeTest icons/i.test(traceLine)) return 'icons';
  if (/GeeTest match/i.test(traceLine)) return 'match';
  if (/^Arkose/i.test(traceLine)) return 'arkose';
  if (/press and hold/i.test(traceLine)) return 'hold';
  if (/text captcha/i.test(traceLine)) return 'text';
  if (/proof of work/i.test(traceLine)) return 'pow';
  if (/dragging/i.test(traceLine)) return 'drag';
  if (/clicking/i.test(traceLine)) return 'click';
  if (/another challenge|asking for another/i.test(traceLine)) return 'refresh';
  return undefined;
}

/** The family a run belongs to: the widget the solver named, else what its steps show. */
export function familyOf(widget: string | undefined, steps: string[]): string {
  if (widget && widget !== 'slider') return widget;
  if (steps.some(s => s === 'slide' || s === 'board' || s === 'icons' || s === 'match')) return 'geetest';
  if (steps.includes('arkose')) return 'arkose';
  if (steps.includes('hold')) return 'hold';
  if (steps.includes('text')) return 'text';
  if (steps.includes('pow')) return 'pow';
  return widget ?? 'unknown';
}
