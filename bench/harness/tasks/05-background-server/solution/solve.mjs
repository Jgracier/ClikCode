// Reference solution, run by `run.mjs --self-check` in the work copy.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const server = spawn('node', ['server.mjs'], { stdio: ['ignore', 'pipe', 'inherit'] });
const base = await new Promise((resolve, reject) => {
  let seen = '';
  server.stdout.on('data', (chunk) => {
    seen += chunk;
    const match = /listening on (http:\/\/\S+)/.exec(seen);
    if (match) resolve(match[1]);
  });
  server.on('exit', () => reject(new Error('server exited')));
});
const token = await (await fetch(`${base}/token`)).text();
const answer = await (await fetch(`${base}/stock?sku=C-310`, { headers: { 'x-token': token } })).text();
writeFileSync('answer.json', answer);
server.kill();
await new Promise((resolve) => server.on('exit', resolve));
