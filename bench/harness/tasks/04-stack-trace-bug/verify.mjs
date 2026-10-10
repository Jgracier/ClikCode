import { readFileSync } from 'node:fs';
import { check, fail, runHidden, runNpmTest, sourceFiles } from '../../lib/verify.mjs';

const task = import.meta.dirname;
await check(() => {
  const tests = sourceFiles().filter((path) => path.startsWith('test/')).map((path) => readFileSync(path, 'utf8')).join('\n');
  if (!/OLD-|tags\s*:\s*undefined|without tags|no tags|missing tags/i.test(tests)) fail('no regression test for a ticket without tags');
  runNpmTest();
  runHidden(task);
});
