import { readFileSync } from 'node:fs';
import { check, fail, runHidden, runNpmTest, sourceFiles } from '../../lib/verify.mjs';

const task = import.meta.dirname;
await check(() => {
  const source = readFileSync('src/duration.ts', 'utf8');
  if (/\b(1000|60000|60_000|3600000|3_600_000|86400000|604800000)\b/.test(source)) fail('duration.ts has its own millisecond constants');
  const tests = sourceFiles().filter((path) => path.startsWith('test/')).map((path) => readFileSync(path, 'utf8')).join('\n');
  if ((tests.match(/\b(test|it)\(/g) ?? []).length < 4) fail('no tests were added');
  if (!/throws/.test(tests)) fail('the tests do not cover the invalid cases');
  runNpmTest();
  runHidden(task);
});
