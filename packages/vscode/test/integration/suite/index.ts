import Mocha from 'mocha';
import { turnSuite } from './turn';

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'bdd', timeout: 240_000, color: true });
  mocha.suite.emit('pre-require', globalThis, 'turn', mocha);
  turnSuite();
  return new Promise((resolve, reject) => {
    mocha.run((failures) => (failures ? reject(new Error(`${failures} integration test(s) failed`)) : resolve()));
  });
}
