/** @-mentions: finding workspace files for the composer, and turning the
 * editor's selection or a file into a mention. */
import * as vscode from 'vscode';
import type { Mention } from './webview-protocol';
import { mentionScore } from './text';

const EXCLUDE = '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/.next/**,**/build/**,**/coverage/**}';
const LIST_TTL_MS = 30_000;
let listing: { at: number; files: Promise<vscode.Uri[]> } | undefined;

function workspaceFiles(): Promise<vscode.Uri[]> {
  if (!listing || Date.now() - listing.at > LIST_TTL_MS) {
    listing = { at: Date.now(), files: Promise.resolve(vscode.workspace.findFiles('**/*', EXCLUDE, 20_000)) };
  }
  return listing.files;
}

export async function searchWorkspaceFiles(typed: string, limit = 30): Promise<Mention[]> {
  const open = vscode.window.tabGroups.all.flatMap((group) => group.tabs)
    .map((tab) => (tab.input instanceof vscode.TabInputText ? tab.input.uri : undefined))
    .filter((uri): uri is vscode.Uri => Boolean(uri && uri.scheme === 'file'));
  const all = [...open, ...(await workspaceFiles())];
  const seen = new Set<string>();
  const ranked: Array<{ mention: Mention; score: number; order: number }> = [];
  all.forEach((uri, order) => {
    if (seen.has(uri.fsPath)) return;
    seen.add(uri.fsPath);
    const label = vscode.workspace.asRelativePath(uri, false);
    const score = mentionScore(label, typed.trim());
    if (score === undefined) return;
    ranked.push({ mention: { path: uri.fsPath, label }, score: score + (order < open.length ? -0.5 : 0), order });
  });
  ranked.sort((left, right) => left.score - right.score || left.mention.label.length - right.mention.label.length || left.order - right.order);
  return ranked.slice(0, limit).map((item) => item.mention);
}

/** The active editor's selection as a mention, or the whole file when
 * nothing is selected. */
export function mentionFromEditor(editor: vscode.TextEditor): Mention {
  const { document, selection } = editor;
  const label = vscode.workspace.asRelativePath(document.uri, false);
  if (selection.isEmpty) return { path: document.uri.fsPath, label };
  const endLine = selection.end.character === 0 && selection.end.line > selection.start.line ? selection.end.line : selection.end.line + 1;
  return {
    path: document.uri.fsPath, label, startLine: selection.start.line + 1, endLine,
    text: document.getText(selection), languageId: document.languageId,
  };
}

export function mentionFromUri(uri: vscode.Uri): Mention {
  return { path: uri.fsPath, label: vscode.workspace.asRelativePath(uri, false) };
}
