#!/usr/bin/env node
/** A real Amp turn, isolated by vendor-sandbox: a steer typed during a tool
 * waits for it, is echoed by Amp, and changes the same run's final answer. */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (!process.env.VERIFY_AMP_INSIDE) {
  const result = spawnSync(process.execPath, [join(root, 'scripts/vendor-sandbox.mjs'), '--auth', 'amp', '--', process.execPath, fileURLToPath(import.meta.url)],
    { stdio: 'inherit', env: { ...process.env, VERIFY_AMP_INSIDE: '1' } });
  process.exit(result.status ?? 1);
}
const home = process.env.HOME;
const bundle = join(home, 'amp-steering.mjs');
await build({ stdin: { contents: "export { createAmpStreamTurn, ampUserMessage } from './src/harness/transport/native/amp-stream.ts'; export { LiveTurnInputBroker } from './src/turn/live-input.ts';", resolveDir: root, loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', outfile: bundle, logLevel: 'error' });
const { createAmpStreamTurn, ampUserMessage, LiveTurnInputBroker } = await import(pathToFileURL(bundle).href);
const workspace = join(home, 'work');
mkdirSync(workspace, { recursive: true });
const marker = join(workspace, 'finished.txt');
const prompt = `Use shell_command to run this exact command and wait for it to finish: sleep 3; printf 'TOOL_FINISHED' > '${marker}'. Then answer ORIGINAL_DONE. Do not start a subagent.`;
const steer = 'Change your final answer to STEER_PROOF_73. Keep the shell command running to completion.';
const flags = ['--execute', '--stream-json', '--stream-json-input', '--no-archive-after-execute'];
const child = spawn('amp', flags, { cwd: workspace, stdio: ['pipe', 'pipe', 'pipe'] });
const broker = new LiveTurnInputBroker();
broker.bindQueue(async () => undefined);
let acknowledged = false;
let submitted = false;
let held = false;
let answer = '';
let errors = '';
let landing;
let threadId;
const turn = createAmpStreamTurn({ prompt, write: (text) => { child.stdin.write(text); return true; }, close: () => child.stdin.end() });
broker.setSteerHandler(async (text, _submission, hold) => { await turn.steer(text, hold); acknowledged = true; });
child.stderr.on('data', (data) => { errors = (errors + data).slice(-2000); });
let buffer = '';
child.stdout.on('data', (data) => {
  buffer += data;
  for (let at; (at = buffer.indexOf('\n')) >= 0;) {
    const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
    let record; try { record = JSON.parse(line); } catch { continue; }
    if (typeof record.session_id === 'string') threadId = record.session_id;
    turn.note(record);
    if (record.type === 'assistant' && !record.parent_tool_use_id) {
      const content = record.message?.content ?? [];
      answer += content.filter((part) => part.type === 'text').map((part) => part.text).join('');
      if (!submitted && content.some((part) => part.type === 'tool_use')) {
        submitted = true;
        landing = broker.submit(steer).then(async (result) => { held = result.disposition === 'queued' && !result.unsteered; if (result.landed) await result.landed; });
      }
    }
  }
});
child.stdin.write(ampUserMessage(prompt));
const timer = setTimeout(() => child.kill('SIGTERM'), 120_000);
const [code] = await new Promise((resolve) => child.once('exit', (...args) => resolve(args)));
clearTimeout(timer);
turn.ended();
if (landing) await landing;
const toolFinished = existsSync(marker) && readFileSync(marker, 'utf8') === 'TOOL_FINISHED';
let resumed = false;
if (code === 0 && threadId && acknowledged) {
  const next = spawnSync('amp', ['threads', 'continue', threadId, ...flags], { cwd: workspace, encoding: 'utf8', timeout: 60_000,
    input: ampUserMessage('What exact final answer did I ask you to give? Return that answer only.') });
  const records = (next.stdout ?? '').split('\n').flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
  resumed = next.status === 0 && records.some((record) => record.type === 'result' && record.session_id === threadId && record.result?.includes('STEER_PROOF_73'));
  if (!resumed) errors += next.stderr ?? '';
}
const proof = { code, submitted, held, acknowledged, toolFinished, sameRunAnswer: answer.includes('STEER_PROOF_73'), resumed };
console.log(JSON.stringify(proof));
if (!Object.values(proof).slice(1).every(Boolean) || code !== 0) { console.error(errors); process.exitCode = 1; }
