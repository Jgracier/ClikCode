/** @-mentions: finding workspace files for the composer, and turning the
 * editor's selection or a file into a mention. */
import * as vscode from 'vscode';
import type { Mention } from './webview-protocol';
import { execFile } from 'node:child_process';
import { mentionScore } from './text';

const EXCLUDE = '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/.next/**,**/build/**,**/coverage/**}';
const LIMIT = 20_000;
const LIST_TTL_MS = 30_000;
let listing: { at: number; files: Promise<vscode.Uri[]> } | undefined;

/** A folder's files as git sees them: tracked, plus untracked ones no ignore
 * file excludes -- what the project's own .gitignore says is its source.
 * Undefined outside a repository. `core.fsmonitor=` keeps a repository's
 * config from running a program of its choosing. */
function gitFiles(folder: vscode.Uri): Promise<vscode.Uri[] | undefined> {
  return new Promise((resolve) => {
    execFile('git', ['-c', 'core.fsmonitor=', '-C', folder.fsPath, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      { maxBuffer: 64 * 1024 * 1024, timeout: 10_000 }, (error, stdout) => {
        if (error) { resolve(undefined); return; }
        resolve(stdout.split('\0').filter(Boolean).slice(0, LIMIT).map((path) => vscode.Uri.joinPath(folder, path)));
      });
  });
}

async function listWorkspaceFiles(): Promise<vscode.Uri[]> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const perFolder = await Promise.all(folders.map(async (folder) => (folder.uri.scheme === 'file' ? await gitFiles(folder.uri) : undefined)
    // Not a repository (or no git): a fixed list of the usual build output.
    ?? await vscode.workspace.findFiles(new vscode.RelativePattern(folder, '**/*'), EXCLUDE, LIMIT)));
  return perFolder.flat().slice(0, LIMIT);
}

function workspaceFiles(): Promise<vscode.Uri[]> {
  if (!listing || Date.now() - listing.at > LIST_TTL_MS) listing = { at: Date.now(), files: listWorkspaceFiles() };
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
 * nothing is selected; with the errors and warnings VS Code reports there
 * when `withProblems`. */
export function mentionFromEditor(editor: vscode.TextEditor, withProblems = false): Mention {
  const { document, selection } = editor;
  const label = vscode.workspace.asRelativePath(document.uri, false);
  const problems = withProblems ? problemsIn(document.uri, selection.isEmpty ? undefined : selection) : [];
  const extra = problems.length ? { problems } : {};
  if (selection.isEmpty) return { path: document.uri.fsPath, label, ...extra };
  const endLine = selection.end.character === 0 && selection.end.line > selection.start.line ? selection.end.line : selection.end.line + 1;
  return {
    path: document.uri.fsPath, label, startLine: selection.start.line + 1, endLine,
    text: document.getText(selection), languageId: document.languageId, ...extra,
  };
}

const PROBLEM_LIMIT = 20;

/** Errors and warnings in a file (or a range of it), worst and first first. */
export function problemsIn(uri: vscode.Uri, range?: vscode.Range): string[] {
  return vscode.languages.getDiagnostics(uri)
    .filter((item) => item.severity <= vscode.DiagnosticSeverity.Warning && (!range || item.range.intersection(range)))
    .sort((left, right) => left.severity - right.severity || left.range.start.line - right.range.start.line)
    .slice(0, PROBLEM_LIMIT)
    .map((item) => {
      const code = typeof item.code === 'object' ? item.code.value : item.code;
      const source = [item.source, code].filter((part) => part !== undefined && part !== '').join(' ');
      const message = item.message.replace(/\s+/g, ' ').trim();
      return `line ${item.range.start.line + 1} ${item.severity === vscode.DiagnosticSeverity.Error ? 'error' : 'warning'}: ${message}${source ? ` (${source})` : ''}`;
    });
}

export function mentionFromUri(uri: vscode.Uri): Mention {
  return { path: uri.fsPath, label: vscode.workspace.asRelativePath(uri, false) };
}
