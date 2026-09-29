import Mocha from 'mocha';
import { chatSuite } from './chat';
import { screensSuite } from './screens';

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'bdd', timeout: 300_000, color: true, ...(process.env.CLIKCODE_IT_GREP ? { grep: process.env.CLIKCODE_IT_GREP } : {}) });
  mocha.suite.emit('pre-require', globalThis, 'suite', mocha);
  if (process.env.CLIKCODE_IT_SUITE === 'screens') screensSuite();
  else chatSuite();
  return new Promise((resolve, reject) => {
    mocha.run((failures) => (failures ? reject(new Error(`${failures} integration test(s) failed`)) : resolve()));
  });
}
