/** Applying a setting chosen from a picker: to this chat, straight away.
 *
 * It used to ask a second question first -- "This chat only / Global default /
 * <provider> default" -- after every effort, permissions and failover choice.
 * The answer is "this chat" nearly every time, and the other two already have
 * a direct route that says what it means: `/settings global <key> <value>`
 * and `/settings provider <id> <key> <value>`. So the picker does the obvious
 * thing and the status line shows it done.
 *
 * Its own module because the effort and permission pickers both need it while
 * settings.ts pulls both of those pickers in -- defining it in settings.ts made
 * the three depend on each other in a loop.
 */

import { aiSessionCommand } from '../slash/handlers.js';

export async function applyToChat(
  id: string, key: 'effort' | 'permissions' | 'failover', value: string,
): Promise<void> {
  await aiSessionCommand(id, key === 'failover' ? `/accounts failover ${value}` : `/${key} ${value}`);
}

/** How a setting's value reads in every list: `xhigh` as `Xhigh`, the same in
 * Settings and in the picker it opens. */
export function settingLabel(value: string): string {
  return value ? value[0]!.toUpperCase() + value.slice(1) : 'Default';
}
