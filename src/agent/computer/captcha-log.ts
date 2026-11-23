/** What each human check turned out to be and how it ended, one line per solver run, so the next family to work
 * on is read from what sign-ups actually met, not guessed. Lines hold the site's host, the check's family,
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
  /** hCaptcha only: the kinds of challenge answered (the instruction with its particulars removed). */
  kinds?: string[];
  /** What the run cost: how many model asks it made, and how many went to each model (a `subscription-` name is
   * the user's own Claude or Codex plan, the rest are Gateway credit). */
  asks?: number;
  models?: Record<string, number>;
  /** A run that did not clear: what the check showed at the end, in the solver's words or the widget's own short status words
   * (Turnstile's "Verification failed"), never the page's text. */
  seen?: string;
  /** The way out the page's traffic left through (egress.ts); absent for home, this computer's own connection. */
  egress?: string;
}

export function captchaLogPath(stateDir: string): string { return path.join(stateDir, 'computer', 'captcha-log.jsonl'); }

/** The log is rotated past this size: everything older than the longest window any reader uses (30 days) is dropped. */
export const CAPTCHA_LOG_MAX_BYTES = 1_000_000;
const KEEP_MS = 30 * 86_400_000;

export async function recordCaptcha(stateDir: string, record: CaptchaRecord, now = Date.now()): Promise<void> {
  try {
    const file = captchaLogPath(stateDir);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.appendFile(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    if ((await fs.stat(file)).size > CAPTCHA_LOG_MAX_BYTES) await rotate(file, now);
  } catch { /* fail-open-ok: a log that cannot be written never fails a sign-up */ }
}

/** Keeps the last 30 days (and, of those, no more than half the size limit, newest kept), written aside and moved into place. */
async function rotate(file: string, now: number): Promise<void> {
  const kept: string[] = [];
  let bytes = 0;
  const lines = (await fs.readFile(file, 'utf8')).split('\n').filter(line => line.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    let at = NaN;
    try { at = Date.parse((JSON.parse(line) as CaptchaRecord).at); } catch { continue; } // fail-open-ok: a torn line is dropped
    if (!(at >= now - KEEP_MS) || bytes + line.length + 1 > CAPTCHA_LOG_MAX_BYTES / 2) break;
    kept.push(line); bytes += line.length + 1;
  }
  const aside = `${file}.${process.pid}.tmp`;
  await fs.writeFile(aside, kept.reverse().map(line => `${line}\n`).join(''), { mode: 0o600 });
  await fs.rename(aside, file);
}

/** The parsed log, kept while the file is unchanged (same size and time): one solver run asks it three or four questions. */
let parsed: { file: string; size: number; mtimeMs: number; records: CaptchaRecord[] } | undefined;
async function readRecords(stateDir: string): Promise<CaptchaRecord[]> {
  const file = captchaLogPath(stateDir);
  let stat: { size: number; mtimeMs: number };
  try { stat = await fs.stat(file); } catch { return []; }
  if (parsed && parsed.file === file && parsed.size === stat.size && parsed.mtimeMs === stat.mtimeMs) return parsed.records;
  let text = '';
  try { text = await fs.readFile(file, 'utf8'); } catch { return []; }
  const records: CaptchaRecord[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line) as CaptchaRecord); } catch { /* fail-open-ok: a torn line is skipped */ }
  }
  parsed = { file, size: stat.size, mtimeMs: stat.mtimeMs, records };
  return records;
}

async function recordsSince(stateDir: string, since: number): Promise<CaptchaRecord[]> {
  return (await readRecords(stateDir)).filter(record => Date.parse(record.at) >= since);
}

/** Challenge kinds whose answers keep being refused: met in at least three runs in the last 30 days, none of
 * which cleared. The solver swaps these for another challenge instead of spending a try on them. */
export async function weakKinds(stateDir: string, now = Date.now()): Promise<Set<string>> {
  const seen = new Map<string, { runs: number; cleared: number }>();
  for (const record of await recordsSince(stateDir, now - 30 * 86_400_000)) {
    for (const kind of new Set(record.kinds ?? [])) {
      const tally = seen.get(kind) ?? { runs: 0, cleared: 0 };
      tally.runs++; if (record.outcome === 'cleared') tally.cleared++;
      seen.set(kind, tally);
    }
  }
  return new Set([...seen].filter(([, tally]) => tally.runs >= 3 && tally.cleared === 0).map(([kind]) => kind));
}

/** A site that has just refused three answers in a row is left alone for half an hour: every further failed try
 * there lowers how much the site (and its captcha vendor) trusts this browser. Says whether to hold off. */
export async function shouldHoldOff(stateDir: string, host: string, now = Date.now()): Promise<boolean> {
  if (!host) return false;
  const recent = (await recordsSince(stateDir, now - 30 * 60_000)).filter(record => record.host === host && record.outcome !== 'none');
  return recent.length >= 3 && recent.slice(-3).every(record => record.outcome === 'still-there');
}

/** How long the reCAPTCHA spoken clip is left alone after Google refused it ("Try again later"). */
export const RECAPTCHA_REFUSAL_COOLDOWN_MS = 6 * 60 * 60_000;

/** Whether Google refused a reCAPTCHA on this connection within the cooldown: its "Try again later" judges the connection, not one site, so
 * every site's reCAPTCHA leaves the spoken clip (the request that draws the refusal) alone for a while. Judged per way out (`egress`,
 * undefined or `home` for this computer's own connection; records from before egress was kept are home's): a refusal of the home
 * address says nothing about a tunnel's. */
export async function recaptchaRefusedRecently(stateDir: string, now = Date.now(), egress?: string): Promise<boolean> {
  const wanted = egress && egress !== 'home' ? egress : 'home';
  return (await recordsSince(stateDir, now - RECAPTCHA_REFUSAL_COOLDOWN_MS)).some(record => record.family === 'recaptcha' && record.steps.includes('refused') && (record.egress ?? 'home') === wanted);
}

/** Sites being left alone right now (three refusals in a row in the last half hour). */
export async function heldOffHosts(stateDir: string, now = Date.now()): Promise<string[]> {
  const hosts = new Set((await recordsSince(stateDir, now - 30 * 60_000)).map(record => record.host).filter(Boolean));
  const held: string[] = [];
  for (const host of hosts) if (await shouldHoldOff(stateDir, host, now)) held.push(host);
  return held.sort();
}

/** Asks made over the last `days`, by model, most first. */
export async function captchaCost(stateDir: string, days = 30, now = Date.now()): Promise<{ asks: number; subscription: number; models: Array<{ model: string; asks: number }> }> {
  const models = new Map<string, number>();
  for (const record of await recordsSince(stateDir, now - days * 86_400_000)) for (const [model, asks] of Object.entries(record.models ?? {})) models.set(model, (models.get(model) ?? 0) + asks);
  const rows = [...models].map(([model, asks]) => ({ model, asks })).sort((a, b) => b.asks - a.asks);
  return { asks: rows.reduce((total, row) => total + row.asks, 0), subscription: rows.filter(row => row.model.startsWith('subscription-')).reduce((total, row) => total + row.asks, 0), models: rows };
}

// ── which voters to trust, measured ─────────────────────────────────────────────────────────────────────────

type VoterScores = Record<string, Record<string, { asked: number; right: number }>>;
const votersFile = (stateDir: string): string => path.join(stateDir, 'computer', 'captcha-voters.json');
async function readScores(stateDir: string): Promise<VoterScores> {
  try { return JSON.parse(await fs.readFile(votersFile(stateDir), 'utf8')) as VoterScores; } catch { return {}; }
}

/** After a run the site accepted: each voter's answers are counted, and those that sided with the answer given
 * are counted as right. A refused run teaches nothing certain (which of its answers was wrong is not known), so
 * only accepted runs are counted. */
export async function recordVotes(stateDir: string, votes: ReadonlyArray<{ roster: string; model: string; withWinner: boolean }>): Promise<void> {
  if (!votes.length) return;
  try {
    const scores = await readScores(stateDir);
    for (const vote of votes) {
      const row = ((scores[vote.roster] ??= {})[vote.model] ??= { asked: 0, right: 0 });
      row.asked++; if (vote.withWinner) row.right++;
    }
    await fs.mkdir(path.dirname(votersFile(stateDir)), { recursive: true, mode: 0o700 });
    await fs.writeFile(votersFile(stateDir), `${JSON.stringify(scores, null, 2)}\n`, { mode: 0o600 });
  } catch { /* fail-open-ok: a score that cannot be written never fails a sign-up */ }
}

/** Per kind of question, the models measured on at least 20 answers, best first. The solver asks them in this
 * order ahead of its built-in roster order. */
export async function voterOrder(stateDir: string, least = 20): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const [roster, models] of Object.entries(await readScores(stateDir))) {
    const ranked = Object.entries(models).filter(([model, row]) => row.asked >= least && !model.startsWith('subscription-')).sort((a, b) => b[1].right / b[1].asked - a[1].right / a[1].asked).map(([model]) => model);
    if (ranked.length) out[roster] = ranked;
  }
  return out;
}

/** The measured share of right answers per voter, for the stats command. */
export async function voterScores(stateDir: string): Promise<Array<{ roster: string; model: string; asked: number; right: number }>> {
  return Object.entries(await readScores(stateDir)).flatMap(([roster, models]) => Object.entries(models).map(([model, row]) => ({ roster, model, ...row }))).sort((a, b) => a.roster.localeCompare(b.roster) || b.right / b.asked - a.right / a.asked);
}

// ── the stored answer set ───────────────────────────────────────────────────────────────────────────────────

const SAMPLES_KEPT = 300;
/** Keeps the hard questions of a run -- the pictures, what was asked, what each voter said, and whether the site
 * took the answer -- so a change to a prompt or a roster can be checked against real challenges instead of spent
 * on live ones. Only challenge pictures are kept, never a page; the newest 300 questions stay. */
export async function saveSamples(stateDir: string, outcome: string, family: string, samples: ReadonlyArray<{ roster: string; text: string; images: ReadonlyArray<{ mimeType: string; data: string }>; answers: Record<string, string> }>, now = new Date()): Promise<void> {
  if (!samples.length) return;
  try {
    const root = path.join(stateDir, 'computer', 'captcha-samples');
    const stamp = now.toISOString().replace(/[:.]/g, '-');
    for (const [index, sample] of samples.entries()) {
      const dir = path.join(root, `${stamp}-${index + 1}`);
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      const pictures: string[] = [];
      for (const [n, image] of sample.images.entries()) { const name = `picture-${n + 1}.${/png/.test(image.mimeType) ? 'png' : 'jpg'}`; await fs.writeFile(path.join(dir, name), Buffer.from(image.data, 'base64'), { mode: 0o600 }); pictures.push(name); }
      await fs.writeFile(path.join(dir, 'question.json'), `${JSON.stringify({ at: now.toISOString(), family, outcome, roster: sample.roster, text: sample.text, pictures, answers: sample.answers }, null, 2)}\n`, { mode: 0o600 });
    }
    const all = (await fs.readdir(root)).sort();
    for (const old of all.slice(0, Math.max(0, all.length - SAMPLES_KEPT))) await fs.rm(path.join(root, old), { recursive: true, force: true });
  } catch { /* fail-open-ok: the answer set never fails a sign-up */ }
}

export interface CaptchaTally { family: string; runs: number; cleared: number; seconds: number }

/** Runs and clears per family over the last `days`, most runs first. */
export async function captchaTally(stateDir: string, days = 30, now = Date.now()): Promise<CaptchaTally[]> {
  const byFamily = new Map<string, CaptchaTally>();
  for (const record of await recordsSince(stateDir, now - days * 86_400_000)) {
    const tally = byFamily.get(record.family) ?? { family: record.family, runs: 0, cleared: 0, seconds: 0 };
    tally.runs++; if (record.outcome === 'cleared') tally.cleared++; tally.seconds += record.seconds;
    byFamily.set(record.family, tally);
  }
  return [...byFamily.values()].sort((a, b) => b.runs - a.runs);
}

/** The short step word for a solver trace line. */
export function stepOf(traceLine: string): string | undefined {
  if (/^Google refused|\(Google refused it\)/i.test(traceLine)) return 'refused';
  if (/^audio:/i.test(traceLine)) return 'audio';
  if (/^\d+ squares/i.test(traceLine)) return 'pictures';
  if (/GeeTest slide/i.test(traceLine)) return 'slide';
  if (/^slider/i.test(traceLine)) return 'slider';
  if (/holding off/i.test(traceLine)) return 'held-off';
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
