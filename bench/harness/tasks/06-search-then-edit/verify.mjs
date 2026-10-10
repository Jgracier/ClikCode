import { check, fail, filesMatching, runHidden, runNpmTest, sourceFiles } from '../../lib/verify.mjs';

const task = import.meta.dirname;
await check(() => {
  const src = sourceFiles().filter((path) => path.startsWith('src/') && path !== 'src/config/env.ts');
  const direct = filesMatching(/process\s*(\?\.)?\s*\.\s*env|process\s*\[\s*['"]env/, src);
  if (direct.length) fail(`still reads process.env directly: ${direct.join(', ')}`);
  runNpmTest();
  runHidden(task);
});
