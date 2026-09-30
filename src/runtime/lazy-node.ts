/** node:http and node:https, loaded on first use.
 *
 * A static ESM import of node:http makes Node build that module's whole
 * export facade while the CLI loads, and on Node 26 reading its exports loads
 * undici: about 11 ms on every start, for every command, when only a few
 * paths ever make a request. `require` returns the module without the facade.
 */
import { createRequire } from 'node:module';
import type * as Http from 'node:http';
import type * as Https from 'node:https';

const require = createRequire(import.meta.url);

export const nodeHttp = (): typeof Http => require('node:http') as typeof Http;
export const nodeHttps = (): typeof Https => require('node:https') as typeof Https;
