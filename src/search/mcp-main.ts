/** dist/conversations-mcp.js: the conversation MCP server and nothing else.
 *
 * Every vendor chat starts its own copy (`clikcode conversations-mcp`), so it
 * must not load the whole program: dist/index.js sends that one subcommand
 * here before cli.js is read (scripts/build.mjs). Measured on the user's
 * machine: 82 MB and 98 ms to the first reply through cli.js, 53 MB and
 * 32 ms through this file. */
import { serveConversationsMcp } from './mcp.js';

await serveConversationsMcp();
