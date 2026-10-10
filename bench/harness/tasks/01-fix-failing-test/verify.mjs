import { check, filesUnchanged, runHidden, runNpmTest } from '../../lib/verify.mjs';

const task = import.meta.dirname;
await check(() => {
  filesUnchanged(task, ['test/money.test.ts']);
  runNpmTest();
  runHidden(task);
});
