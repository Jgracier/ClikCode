import { check, fail, filesMatching, runHidden, runNpmTest } from '../../lib/verify.mjs';

const task = import.meta.dirname;
await check(() => {
  const left = filesMatching(/calcTotal/);
  if (left.length) fail(`calcTotal still appears in ${left.join(', ')}`);
  const output = runNpmTest();
  const passed = Number(/^\S* ?pass (\d+)/m.exec(output)?.[1] ?? 0);
  if (passed < 5) fail(`only ${passed} tests pass; the suite had 5`);
  runHidden(task);
});
