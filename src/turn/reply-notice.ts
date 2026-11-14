/** A notice the vendor put at the start of the reply that is not the model's
 * answer (catalog `replyNoticePatterns`), taken off. Undefined when the reply
 * has none. */

import type { AiLocalHarnessDefinition } from '../harness/definition.js';

export function withoutReplyNotice(harness: Pick<AiLocalHarnessDefinition, 'replyNoticePatterns'>, text: string): string | undefined {
  let reply = text;
  for (const source of harness.replyNoticePatterns ?? []) {
    const match = new RegExp(source).exec(reply);
    if (match?.index === 0 && match[0].length) reply = reply.slice(match[0].length);
  }
  return reply === text ? undefined : reply;
}
