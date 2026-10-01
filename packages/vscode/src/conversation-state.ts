/** What a conversation in the side bar's list is doing (no VS Code API, so
 * it is tested on its own). */
import type { IdeConversation } from './protocol';

export type ConversationState = 'needs-input' | 'working' | 'unread' | 'idle';

/** What one conversation is doing, from the list and from every open chat
 * showing it: an open chat knows of an approval the list cannot. */
export function conversationState(conversation: Pick<IdeConversation, 'id' | 'activity'>, open: ReadonlyArray<{ sessionId?: string; approvals: number; running: boolean; unread: boolean }>): ConversationState {
  const showing = open.filter((chat) => chat.sessionId === conversation.id);
  if (showing.some((chat) => chat.approvals > 0)) return 'needs-input';
  if (conversation.activity === 'working' || showing.some((chat) => chat.running)) return 'working';
  if (showing.some((chat) => chat.unread)) return 'unread';
  return 'idle';
}
