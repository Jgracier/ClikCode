/** Messages between the extension host and the chat webview. */
import type { ChatModel } from './model';

export type ToWebview =
  | { type: 'model'; model: ChatModel }
  | { type: 'setDraft'; text: string }
  | { type: 'insert'; text: string }
  | { type: 'focus' };

export type FromWebview =
  | { type: 'ready' }
  | { type: 'send'; text: string; id: string }
  | { type: 'cancel'; restoreDraft: boolean }
  | { type: 'approve'; id: string; approved: boolean | 'always' }
  | { type: 'viewDiff'; id: string }
  | { type: 'command'; command: string }
  | { type: 'openLink'; href: string };
