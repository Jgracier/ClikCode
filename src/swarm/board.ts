/** The swarm's short-term memory. Every model reads a slice once. Nobody
 * reads another provider's transcript. A rough token is four characters:
 * the cap is what matters, and this estimate stays on the side of too small. */

export type SwarmRole = 'explore' | 'implement' | 'review';

export interface SwarmFact {
  path: string;
  text: string;
}

export interface SwarmRosterLine {
  id: string;
  provider: string;
  role: SwarmRole;
  paths: string;
  /** One line: what that worker is doing, or the summary once it finishes. */
  step: string;
  /** Role, paths, and goal. A second call with the same key attaches. */
  key: string;
  status: 'working' | 'done';
  /** Which account is doing this, so the next task prefers another one that still has usage. */
  accountId?: string;
}

export interface SwarmBoard {
  goal: string;
  decisions: string[];
  facts: SwarmFact[];
  roster: SwarmRosterLine[];
  open: string[];
}

export interface SwarmCard {
  summary: string;
  facts: string[];
  paths: string[];
  diffstat?: string;
  blockers: string[];
  questions: string[];
}

const MAX_FACTS = 12;
const MAX_DECISIONS = 8;
const MAX_OPEN = 6;

export function emptyBoard(goal = ''): SwarmBoard {
  return { goal, decisions: [], facts: [], roster: [], open: [] };
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function goalKey(role: SwarmRole, paths: readonly string[], prompt: string): string {
  const normalized = prompt.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 80);
  return `${role}|${[...paths].sort().join(',')}|${normalized}`;
}

/** A one-file question stays with the host. Two paths, or a review of the
 * tree, is worth a clerk. */
export function keepOnHost(text: string): boolean {
  const paths = new Set(text.match(/[\w./~-]+\.[A-Za-z0-9]+/g) ?? []);
  if (paths.size >= 2) return false;
  if (/\b(review|across|every file|all files)\b/i.test(text)) return false;
  return text.length < 320;
}

export function swarmRole(text: string): SwarmRole {
  if (/\b(review|nitpick|look over)\b/i.test(text)) return 'review';
  if (/\b(implement|edit|change|fix|update|patch|rewrite)\b/i.test(text)) return 'implement';
  return 'explore';
}

export function pathsIn(text: string): string[] {
  return [...new Set(text.match(/(?:[\w.-]+\/)+[\w.-]+\.\w+|(?:^|[\s`'"])([\w.-]+\.\w+)/g) ?? [])]
    .map((path) => path.replace(/^[\s`'"]+/, ''))
    .slice(0, 8);
}

function overlaps(factPath: string, paths: readonly string[]): boolean {
  if (!paths.length) return true;
  return paths.some((path) => factPath.includes(path) || path.includes(factPath));
}

/** The lines a clerk is allowed to see: the goal, decisions, facts for its
 * paths, and one roster line per peer. Cut from the facts until the slice
 * fits the cap. */
export function boardSlice(board: SwarmBoard, paths: readonly string[], capTokens: number): string {
  const peers = board.roster.map((line) => `${line.provider} ${line.role} ${line.paths} ${line.step}`.trim());
  const decisions = board.decisions.slice(0, MAX_DECISIONS);
  let facts = board.facts.filter((fact) => overlaps(fact.path, paths));
  const render = (): string => [
    board.goal ? `Goal: ${board.goal}` : '',
    decisions.length ? `Decisions:\n${decisions.map((line) => `- ${line}`).join('\n')}` : '',
    facts.length ? `Facts:\n${facts.map((fact) => `- ${fact.path}: ${fact.text}`).join('\n')}` : '',
    peers.length ? `Others:\n${peers.map((line) => `- ${line}`).join('\n')}` : '',
    board.open.length ? `Open:\n${board.open.map((line) => `- ${line}`).join('\n')}` : '',
  ].filter(Boolean).join('\n');
  let text = render();
  while (facts.length && estimateTokens(text) > capTokens) {
    facts = facts.slice(1);
    text = render();
  }
  if (estimateTokens(text) > capTokens) return text.slice(0, capTokens * 4);
  return text;
}

export function formatCard(card: SwarmCard): string {
  return [
    card.summary,
    card.facts.length ? `facts: ${card.facts.join('; ')}` : '',
    card.paths.length ? `paths: ${card.paths.join(', ')}` : '',
    card.diffstat ? `diff: ${card.diffstat}` : '',
    card.blockers.length ? `blockers: ${card.blockers.join('; ')}` : '',
    card.questions.length ? `questions: ${card.questions.join('; ')}` : '',
  ].filter(Boolean).join('\n');
}

function clip(text: string, tokens: number): string {
  const limit = Math.max(16, tokens * 4);
  const trimmed = text.replace(/\s+/g, ' ').trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit - 1).trimEnd()}…`;
}

function asStrings(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim()).slice(0, limit);
}

/** A clerk's reply becomes a card. JSON is used when the reply contains an
 * object; otherwise the reply itself is the summary, cut to the cap. */
export function cardFromReply(reply: string, capTokens: number): SwarmCard {
  const start = reply.indexOf('{');
  const end = reply.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(reply.slice(start, end + 1)) as Record<string, unknown>;
      const summary = clip(typeof parsed.summary === 'string' ? parsed.summary : reply, capTokens);
      const card: SwarmCard = {
        summary,
        facts: asStrings(parsed.facts, 6).map((fact) => clip(fact, 40)),
        paths: asStrings(parsed.paths, 8),
        blockers: asStrings(parsed.blockers, 4).map((line) => clip(line, 40)),
        questions: asStrings(parsed.questions, 4).map((line) => clip(line, 40)),
      };
      if (typeof parsed.diffstat === 'string' && parsed.diffstat.trim()) card.diffstat = clip(parsed.diffstat, 20);
      return card;
    } catch { /* the prose is the summary */ }
  }
  return { summary: clip(reply, capTokens), facts: [], paths: [], blockers: [], questions: [] };
}

/** Fold a card into the board. The worker's roster line becomes its summary.
 * Facts past the cap drop from the front. The card itself is already capped. */
export function applyCard(board: SwarmBoard, workerId: string, card: SwarmCard): SwarmBoard {
  const facts = [
    ...board.facts,
    ...card.facts.map((text) => {
      const split = text.indexOf(':');
      return split > 0 ? { path: text.slice(0, split).trim(), text: text.slice(split + 1).trim() } : { path: card.paths[0] ?? 'note', text };
    }),
  ].slice(-MAX_FACTS);
  const roster = board.roster.map((line) => (line.id === workerId
    ? { ...line, status: 'done' as const, step: card.summary, paths: card.paths[0] ?? line.paths }
    : line));
  return {
    ...board,
    facts,
    roster,
    open: [...board.open, ...card.questions].slice(-MAX_OPEN),
    decisions: board.decisions.slice(-MAX_DECISIONS),
  };
}

/** A new host turn keeps decisions and facts, and forgets who was working. */
export function beginTurn(board: SwarmBoard): SwarmBoard {
  return { ...board, roster: [] };
}

export function clerkBrief(input: { role: SwarmRole; task: string; slice: string }): string {
  return [
    'You are a swarm clerk. Do the task, then reply with one JSON object and nothing else:',
    '{"summary":"","facts":["path: one line"],"paths":[],"diffstat":"","blockers":[],"questions":[]}',
    'summary is one or two sentences. facts are path and one line, never file bodies.',
    'Do not include your tool log.',
    '',
    input.slice ? `Shared memory:\n${input.slice}` : '',
    '',
    `Role: ${input.role}`,
    `Task: ${input.task}`,
  ].filter((line) => line !== '').join('\n');
}
