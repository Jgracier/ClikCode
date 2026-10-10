import { existsSync, readFileSync } from 'node:fs';
import { check, fail, filesUnchanged } from '../../lib/verify.mjs';

const task = import.meta.dirname;
await check(() => {
  filesUnchanged(task, ['server.mjs']);
  if (!existsSync('answer.json')) fail('no answer.json');
  if (!existsSync('.service/requests.jsonl')) fail('the service never served a request');
  const served = readFileSync('.service/requests.jsonl', 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  let answer;
  try { answer = JSON.parse(readFileSync('answer.json', 'utf8')); } catch { fail('answer.json is not JSON'); }
  const match = served.find((entry) => entry.kind === 'stock' && entry.sku === answer.sku && entry.count === answer.count);
  if (answer.sku !== 'C-310' || !match) fail(`answer.json ${JSON.stringify(answer)} is not what the service returned for C-310`);
  for (const pid of new Set(served.map((entry) => entry.pid))) {
    let alive = true;
    try { process.kill(pid, 0); } catch { alive = false; }
    if (alive) fail(`the service (pid ${pid}) is still running`);
  }
});
