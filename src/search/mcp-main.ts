/** The entry of dist/conversations-mcp.js: the conversation server alone,
 * without the rest of ClikCode. A vendor keeps one of these per session for
 * as long as the session lives, so what it loads is paid many times over. */
import { serveConversationsMcp } from './mcp.js';

await serveConversationsMcp();
