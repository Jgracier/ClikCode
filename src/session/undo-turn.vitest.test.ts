import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HarnessActivityEvent } from '../harness/prompter.js';
import { runGatewayHarnessTurn } from '../agent/run-turn.js';
import { disposeSessionState } from '../agent/session-state.js';
import { ScriptedModelClient, type ScriptEntry } from '../agent/testing.js';
import { eventDiff } from '../agent/line-diff.js';
import { toolFacts } from '../harness/protocol/activity-events.js';
import { FileCheckpointStore } from '../agent/file-checkpoints.js';
import { resolveSlashCommand } from '../tui/slash/registry.js';
import type { AiLocalHarnessDefinition } from '../harness/definition.js';
import type { HarnessSession } from './model.js';
import { appendTurnChanges, readTurnChanges, TurnRecorder } from './turn-changes.js';
import { undoLastTurn as undoTurn } from './undo-turn.js';

const undoLastTurn = (s: HarnessSession, options: { stateDir: string; who: string }) => undoTurn(s, { ...options, turnIsRunning: async () => false });

let root: string;
let cwd: string;
let stateDir: string;
const sessionIds: string[] = [];

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cc-undo-')));
  cwd = path.join(root, 'work');
  stateDir = path.join(root, 'state');
  await Promise.all([cwd, stateDir, path.join(root, 'home')].map((dir) => fs.mkdir(dir, { recursive: true })));
});

afterEach(async () => {
  for (const id of sessionIds.splice(0)) disposeSessionState(stateDir, id);
  await fs.rm(root, { recursive: true, force: true });
});

function session(id: string, route: HarnessSession['route']): HarnessSession {
  sessionIds.push(id);
  return { id, route, workspace: cwd } as HarnessSession;
}

/** One real turn of ClikCode's agent: its file tools write `cwd` and
 * snapshot what they overwrite, recorded as runSessionTurn records it.
 * Returns the activity events it reported. */
async function agentTurn(id: string, script: ScriptEntry[], prompt = 'edit'): Promise<HarnessActivityEvent[]> {
  const events: HarnessActivityEvent[] = [];
  const recorder = new TurnRecorder(prompt, 'agent');
  recorder.start();
  await runGatewayHarnessTurn({
    sessionId: id, cwd, stateDir, homeDir: path.join(root, 'home'), userConfigDir: path.join(root, 'config'),
    prompt, permissionMode: 'bypass', modelClient: new ScriptedModelClient([...script, { text: 'Done.' }]),
    onActivity: (event) => { events.push(event); recorder.add(event); },
  });
  await recorder.finish(stateDir, id);
  return events;
}

/** A vendor turn as the turn journal sees it: every activity is fed to the
 * turn's recorder, written when the turn ends. */
async function reportTurn(id: string, events: HarnessActivityEvent[], prompt = 'edit'): Promise<void> {
  const recorder = new TurnRecorder(prompt, 'reported');
  recorder.start();
  for (const event of events) recorder.add(event);
  await recorder.finish(stateDir, id);
}

const read = (name: string): Promise<string> => fs.readFile(path.join(cwd, name), 'utf8');
const exists = (name: string): Promise<boolean> => fs.stat(path.join(cwd, name)).then(() => true, () => false);

describe("/undo on ClikCode's agent (file snapshots)", () => {
  it("restores a turn's edits, removes what it created, and reports the files", async () => {
    await fs.writeFile(path.join(cwd, 'a.txt'), 'hello\nworld\n');
    const s = session('agent-1', 'clikcode-local');
    await agentTurn(s.id, [
      { toolCalls: [{ name: 'read_file', args: { path: 'a.txt' } }] },
      { toolCalls: [{ name: 'edit_file', args: { path: 'a.txt', old_string: 'world', new_string: 'there' } }] },
      { toolCalls: [{ name: 'write_file', args: { path: 'new.txt', content: 'made\n' } }] },
    ]);
    expect(await read('a.txt')).toBe('hello\nthere\n');
    expect(await read('new.txt')).toBe('made\n');

    const undone = await undoLastTurn(s, { stateDir, who: 'ClikCode Local' });
    expect(undone.restored).toEqual([path.join(cwd, 'a.txt')]);
    expect(undone.removed).toEqual([path.join(cwd, 'new.txt')]);
    expect(undone.conflicts).toEqual([]);
    expect(undone.text).toMatch(/restored\s+a\.txt/);
    expect(await read('a.txt')).toBe('hello\nworld\n');
    expect(await exists('new.txt')).toBe(false);
    expect((await undoLastTurn(s, { stateDir, who: 'ClikCode Local' })).text).toMatch(/^Nothing to undo/);
  });

  it('leaves a file edited by hand after the turn alone, and undoes the rest', async () => {
    await fs.writeFile(path.join(cwd, 'a.txt'), 'A\n');
    await fs.writeFile(path.join(cwd, 'b.txt'), 'B\n');
    const s = session('agent-2', 'gateway');
    await agentTurn(s.id, [
      { toolCalls: [{ name: 'read_file', args: { path: 'a.txt' } }, { name: 'read_file', args: { path: 'b.txt' } }] },
      { toolCalls: [{ name: 'write_file', args: { path: 'a.txt', content: 'A2\n' } }, { name: 'write_file', args: { path: 'b.txt', content: 'B2\n' } }] },
    ]);
    expect(await read('b.txt')).toBe('B2\n');
    await fs.writeFile(path.join(cwd, 'b.txt'), 'B2\nmine\n');

    const undone = await undoLastTurn(s, { stateDir, who: 'ClikDeploy Gateway' });
    expect(undone.restored).toEqual([path.join(cwd, 'a.txt')]);
    expect(undone.conflicts).toEqual([{ path: path.join(cwd, 'b.txt'), reason: expect.stringMatching(/changed since/) }]);
    expect(undone.text).toMatch(/kept\s+b\.txt/);
    expect(await read('a.txt')).toBe('A\n');
    expect(await read('b.txt')).toBe('B2\nmine\n');

    // Put back as the turn left it, the kept file undoes on the next try --
    // and the file already restored is not reported as changed since.
    await fs.writeFile(path.join(cwd, 'b.txt'), 'B2\n');
    const retry = await undoLastTurn(s, { stateDir, who: 'ClikDeploy Gateway' });
    expect(retry).toMatchObject({ restored: [path.join(cwd, 'b.txt')], conflicts: [] });
    expect(await read('b.txt')).toBe('B\n');
  });
});

describe('/undo on a vendor harness (reported diffs)', () => {
  it("reverses the turn's edits newest first and removes a file it created", async () => {
    const s = session('vendor-1', 'local');
    await fs.writeFile(path.join(cwd, 'a.txt'), 'one\ntwo\nthree\n');
    // The vendor edits a.txt twice and creates n.txt; it reports each call.
    await fs.writeFile(path.join(cwd, 'a.txt'), 'one\n2\nthree\n');
    await fs.writeFile(path.join(cwd, 'a.txt'), 'one\n2\n3\n');
    await fs.writeFile(path.join(cwd, 'n.txt'), 'new\nfile\n');
    await reportTurn(s.id, [
      { kind: 'tool-start', id: 'c1', label: 'Edit a.txt' },
      { kind: 'tool-done', id: 'c1', label: 'Edit a.txt', diff: eventDiff('two', '2', { path: 'a.txt' }) },
      // The same call reported finished again: counted once.
      { kind: 'tool-done', id: 'c1', label: 'Edit a.txt (done)', diff: eventDiff('two', '2', { path: 'a.txt' }) },
      { kind: 'tool-done', id: 'c2', label: 'Edit a.txt', diff: eventDiff('three', '3', { path: path.join(cwd, 'a.txt') }) },
      { kind: 'tool-error', id: 'c3', label: 'Edit gone.txt', diff: eventDiff('x', 'y', { path: 'gone.txt' }) },
      { kind: 'tool-done', id: 'c4', label: 'Write n.txt', diff: eventDiff('', 'new\nfile\n', { path: 'n.txt', numbered: true }) },
    ]);

    const undone = await undoLastTurn(s, { stateDir, who: 'OpenCode' });
    expect(undone.conflicts).toEqual([]);
    expect(await read('a.txt')).toBe('one\ntwo\nthree\n');
    expect(await exists('n.txt')).toBe(false);
    expect(undone.removed).toEqual([path.join(cwd, 'n.txt')]);
    expect(await readTurnChanges(stateDir, s.id)).toEqual([]);
  });

  it('never overwrites a file changed by hand where the turn edited it, or delete a created file edited since', async () => {
    const s = session('vendor-2', 'local');
    await fs.writeFile(path.join(cwd, 'a.txt'), 'keep\nold\nkeep\n');
    await fs.writeFile(path.join(cwd, 'b.txt'), 'b-old\n');
    await fs.writeFile(path.join(cwd, 'a.txt'), 'keep\nnew\nkeep\n');
    await fs.writeFile(path.join(cwd, 'b.txt'), 'b-new\n');
    await fs.writeFile(path.join(cwd, 'n.txt'), 'made\n');
    await reportTurn(s.id, [
      { kind: 'tool-done', id: 'c1', label: 'Edit a.txt', diff: eventDiff('old', 'new', { path: 'a.txt' }) },
      { kind: 'tool-done', id: 'c2', label: 'Edit b.txt', diff: eventDiff('b-old', 'b-new', { path: 'b.txt' }) },
      { kind: 'tool-done', id: 'c3', label: 'Write n.txt', diff: eventDiff('', 'made\n', { path: 'n.txt', numbered: true }) },
    ]);
    // Over the very text the turn wrote: the turn's change is no longer there to take back.
    await fs.writeFile(path.join(cwd, 'a.txt'), 'keep\nmine now\nkeep\n');
    await fs.writeFile(path.join(cwd, 'n.txt'), 'made\nand mine\n');

    const undone = await undoLastTurn(s, { stateDir, who: 'OpenCode' });
    expect(undone.restored).toEqual([path.join(cwd, 'b.txt')]);
    expect(undone.conflicts.map((item) => item.path).sort()).toEqual([path.join(cwd, 'a.txt'), path.join(cwd, 'n.txt')]);
    expect(await read('a.txt')).toBe('keep\nmine now\nkeep\n');
    expect(await read('n.txt')).toBe('made\nand mine\n');
    expect(await read('b.txt')).toBe('b-old\n');
    // What could not be undone stays recorded; what was undone does not.
    expect((await readTurnChanges(stateDir, s.id))[0]?.changes.map((change) => change.path).sort()).toEqual(['a.txt', 'n.txt']);
  });

  it('never deletes or blanks a file a write tool overwrote without saying what it held', async () => {
    const s = session('vendor-overwrite', 'local');
    await fs.writeFile(path.join(cwd, 'a.txt'), 'ORIGINAL precious content\n');
    await fs.writeFile(path.join(cwd, 'a.txt'), 'new\ncontent\n');
    // A vendor Write reports its input only: the new content, nothing of what it replaced.
    await reportTurn(s.id, [
      { kind: 'tool-done', id: 'w1', label: 'Write a.txt', ...toolFacts('Write', { file_path: 'a.txt', content: 'new\ncontent\n' }, 'claude') },
    ]);
    const undone = await undoLastTurn(s, { stateDir, who: 'Claude Code' });
    expect(undone.removed).toEqual([]);
    expect(undone.restored).toEqual([]);
    expect(undone.conflicts).toEqual([{ path: path.join(cwd, 'a.txt'), reason: expect.stringMatching(/not what the file held before/) }]);
    expect(await read('a.txt')).toBe('new\ncontent\n');
  });

  it('takes back a replacement inside a line, and leaves other lines that look like it alone', async () => {
    const s = session('vendor-fragment', 'local');
    await fs.writeFile(path.join(cwd, 'a.txt'), 'x = 2\nlist:\n2\n');
    await reportTurn(s.id, [
      { kind: 'tool-done', id: 'e1', label: 'Edit a.txt', ...toolFacts('Edit', { file_path: 'a.txt', old_string: 'x = 1', new_string: 'x = 2' }, 'claude') },
    ]);
    expect((await undoLastTurn(s, { stateDir, who: 'Claude Code' })).restored).toEqual([path.join(cwd, 'a.txt')]);
    expect(await read('a.txt')).toBe('x = 1\nlist:\n2\n');
  });

  it('refuses a replacement whose new text is not found exactly once, rather than guess', async () => {
    const s = session('vendor-fragment-ambiguous', 'local');
    await fs.writeFile(path.join(cwd, 'a.txt'), 'x = 2\nlist:\n2\n');
    await reportTurn(s.id, [
      { kind: 'tool-done', id: 'e1', label: 'Edit a.txt', ...toolFacts('Edit', { file_path: 'a.txt', old_string: '1', new_string: '2' }, 'claude') },
    ]);
    const undone = await undoLastTurn(s, { stateDir, who: 'Claude Code' });
    expect(undone.restored).toEqual([]);
    expect(await read('a.txt')).toBe('x = 2\nlist:\n2\n');
  });

  it('keeps a hand edit beside the text the turn changed', async () => {
    const s = session('vendor-beside', 'local');
    await fs.writeFile(path.join(cwd, 'a.txt'), 'keep\nnew, then mine\nkeep\n');
    await reportTurn(s.id, [
      { kind: 'tool-done', id: 'e1', label: 'Edit a.txt', diff: eventDiff('old', 'new', { path: 'a.txt' }) },
    ]);
    await undoLastTurn(s, { stateDir, who: 'OpenCode' });
    expect(await read('a.txt')).toBe('keep\nold, then mine\nkeep\n');
  });

  it('works from the same diffs a real agent turn reports', async () => {
    const s = session('vendor-3', 'local');
    await fs.writeFile(path.join(cwd, 'a.txt'), 'hello\nworld\n');
    const events = await agentTurn('vendor-3-run', [
      { toolCalls: [{ name: 'read_file', args: { path: 'a.txt' } }] },
      { toolCalls: [{ name: 'edit_file', args: { path: 'a.txt', old_string: 'world', new_string: 'there' } }] },
    ]);
    sessionIds.push('vendor-3-run');
    expect(await read('a.txt')).toBe('hello\nthere\n');
    await reportTurn(s.id, events);
    expect((await undoLastTurn(s, { stateDir, who: 'OpenCode' })).conflicts).toEqual([]);
    expect(await read('a.txt')).toBe('hello\nworld\n');
  });

  it('says why when the harness reported no edits', async () => {
    const s = session('vendor-4', 'local');
    expect((await undoLastTurn(s, { stateDir, who: 'OpenCode' })).text).toMatch(/^Nothing to undo: no turn in this conversation has recorded file edits/);
  });
});

describe('/undo acts on the actual last turn', () => {
  const edit = (name: string, from: string, to: string): HarnessActivityEvent => (
    { kind: 'tool-done', id: `e-${name}-${to}`, label: `Edit ${name}`, diff: eventDiff(from, to, { path: name }) });

  it('says the last turn made no edits instead of reaching back to an older one, then walks back naming it', async () => {
    const s = session('walk-1', 'local');
    await fs.writeFile(path.join(cwd, 'a.txt'), 'new\n');
    await reportTurn(s.id, [edit('a.txt', 'old', 'new')], 'change a to new');
    await reportTurn(s.id, [], 'what does a.txt say');

    const first = await undoLastTurn(s, { stateDir, who: 'OpenCode' });
    expect(first.text).toMatch(/^Nothing undone: the turn "what does a\.txt say" made no edits ClikCode saw/);
    expect(first.text).toMatch(/\/undo again undoes the turn "change a to new"/);
    expect(await read('a.txt')).toBe('new\n');

    const second = await undoLastTurn(s, { stateDir, who: 'OpenCode' });
    expect(second.text).toMatch(/^Undid the turn "change a to new": its changes to 1 file/);
    expect(await read('a.txt')).toBe('old\n');
  });

  it("does not undo an older agent turn's snapshots when the last agent turn made no edits", async () => {
    await fs.writeFile(path.join(cwd, 'a.txt'), 'A\n');
    const s = session('walk-agent', 'clikcode-local');
    await agentTurn(s.id, [
      { toolCalls: [{ name: 'read_file', args: { path: 'a.txt' } }] },
      { toolCalls: [{ name: 'write_file', args: { path: 'a.txt', content: 'A2\n' } }] },
    ], 'rewrite a');
    await agentTurn(s.id, [], 'just talk');
    expect((await undoLastTurn(s, { stateDir, who: 'ClikCode Local' })).text).toMatch(/the turn "just talk" made no edits ClikCode saw/);
    expect(await read('a.txt')).toBe('A2\n');
    expect((await undoLastTurn(s, { stateDir, who: 'ClikCode Local' })).restored).toEqual([path.join(cwd, 'a.txt')]);
    expect(await read('a.txt')).toBe('A\n');
  });

  it('undoes each turn with the store that recorded it, whatever route the conversation is on now', async () => {
    await fs.writeFile(path.join(cwd, 'a.txt'), 'A\n');
    // An agent turn, then the conversation moves to a vendor harness.
    await agentTurn('switch', [
      { toolCalls: [{ name: 'read_file', args: { path: 'a.txt' } }] },
      { toolCalls: [{ name: 'write_file', args: { path: 'a.txt', content: 'A2\n' } }] },
    ], 'agent edit');
    await fs.writeFile(path.join(cwd, 'b.txt'), 'b-new\n');
    await reportTurn('switch', [edit('b.txt', 'b-old', 'b-new')], 'vendor edit');
    const onVendor = session('switch', 'local');
    expect((await undoLastTurn(onVendor, { stateDir, who: 'OpenCode' })).restored).toEqual([path.join(cwd, 'b.txt')]);
    expect(await read('b.txt')).toBe('b-old\n');
    expect(await read('a.txt')).toBe('A2\n');
    // Still on the vendor route: the agent turn is undone from its snapshots.
    expect((await undoLastTurn(onVendor, { stateDir, who: 'OpenCode' })).restored).toEqual([path.join(cwd, 'a.txt')]);
    expect(await read('a.txt')).toBe('A\n');
  });

  it('refuses while a turn is running in the conversation', async () => {
    const s = session('running', 'local');
    await fs.writeFile(path.join(cwd, 'a.txt'), 'new\n');
    await reportTurn(s.id, [edit('a.txt', 'old', 'new')]);
    const refused = await undoTurn(s, { stateDir, who: 'OpenCode', turnIsRunning: async () => true });
    expect(refused.text).toMatch(/^Not undone: a turn is running/);
    expect(await read('a.txt')).toBe('new\n');
    expect(await readTurnChanges(stateDir, s.id)).toHaveLength(1);
  });

  it('keeps every record when turns in several processes end together', async () => {
    await Promise.all(Array.from({ length: 8 }, (_, index) => appendTurnChanges(stateDir, 'many', { at: new Date().toISOString(), prompt: `t${index}`, changes: [] })));
    expect((await readTurnChanges(stateDir, 'many')).map((record) => record.prompt).sort()).toEqual(['t0', 't1', 't2', 't3', 't4', 't5', 't6', 't7']);
  });
});

describe('/undo stays inside the workspace', () => {
  it('refuses a reported path outside the workspace, through a symlink too', async () => {
    const s = session('outside-1', 'local');
    const elsewhere = path.join(root, 'elsewhere');
    await fs.mkdir(elsewhere);
    await fs.writeFile(path.join(elsewhere, 'x.txt'), 'new\n');
    await fs.symlink(elsewhere, path.join(cwd, 'link'));
    await reportTurn(s.id, [
      { kind: 'tool-done', id: 'o1', label: 'Edit', diff: eventDiff('old', 'new', { path: path.join(elsewhere, 'x.txt') }) },
      { kind: 'tool-done', id: 'o2', label: 'Edit', diff: eventDiff('new', 'newer', { path: 'link/x.txt' }) },
      { kind: 'tool-done', id: 'o3', label: 'Edit', diff: eventDiff('old', 'new', { path: '../elsewhere/x.txt' }) },
    ]);
    const undone = await undoLastTurn(s, { stateDir, who: 'OpenCode' });
    expect(undone.restored).toEqual([]);
    expect(undone.conflicts).toHaveLength(3);
    for (const conflict of undone.conflicts) expect(conflict.reason).toMatch(/outside this conversation's workspace/);
    expect(await fs.readFile(path.join(elsewhere, 'x.txt'), 'utf8')).toBe('new\n');
    // Never possible here: not kept to block the turns before it.
    expect(await readTurnChanges(stateDir, s.id)).toEqual([]);
  });

  it("refuses an agent snapshot outside the workspace", async () => {
    const s = session('outside-agent', 'gateway');
    const elsewhere = path.join(root, 'elsewhere.txt');
    await fs.writeFile(elsewhere, 'before\n');
    const store = new FileCheckpointStore(stateDir);
    const recorder = new TurnRecorder('write elsewhere', 'agent');
    recorder.start();
    await store.snapshot(s.id, 'turn-1', elsewhere);
    await fs.writeFile(elsewhere, 'after\n');
    await store.seal(s.id, 'turn-1');
    await recorder.finish(stateDir, s.id);
    const undone = await undoLastTurn(s, { stateDir, who: 'Gateway' });
    expect(undone.restored).toEqual([]);
    expect(undone.conflicts[0]?.reason).toMatch(/outside this conversation's workspace/);
    expect(await fs.readFile(elsewhere, 'utf8')).toBe('after\n');
  });
});

describe('/undo availability', () => {
  const harness = (transport: AiLocalHarnessDefinition['transport']): AiLocalHarnessDefinition => (
    { command: 'x', provider: 'x', displayName: 'Aider', surface: 'terminal', transport, localAuth: [], binary: 'x' });
  const undo = (route: HarnessSession['route'], definition?: AiLocalHarnessDefinition) => resolveSlashCommand('undo')!.availability({ id: 's', route } as HarnessSession, definition);

  it("is available on ClikCode's agent and on harnesses that stream their tool calls", () => {
    expect(undo('clikcode-local')).toMatchObject({ available: true });
    expect(undo('local', harness('acp'))).toMatchObject({ available: true });
    expect(undo('local', harness('structured-cli'))).toMatchObject({ available: true });
  });

  it('is unavailable on a plain-text CLI, saying why', () => {
    expect(undo('local', harness('text-cli'))).toMatchObject({ available: false, reason: expect.stringMatching(/Aider runs as a plain-text CLI/) });
  });
});
