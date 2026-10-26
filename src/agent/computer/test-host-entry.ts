/** Test helper: stands in for `clikcode computer-host <stateDir>`. Bundled with esbuild by testHostEntry() so a
 * test can start the real browser host from source. */
import { runComputerHost } from './browser-host.js';

await runComputerHost(process.argv[3]!);
