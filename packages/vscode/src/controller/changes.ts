/** A change in VS Code's diff editor, and undoing it as one WorkspaceEdit:
 * what the agent proposed (an approval), made (a tool row) or did in a turn. */
import * as vscode from 'vscode';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { userError } from '../../../../src/harness/protocol/errors';
import type { ChatModel } from '../model';
import type { FileDiff } from '../protocol';
import { applyHunks, fileHunks, turnChanges, unwindChanges } from '../text';
import { fileNameIn, type DiffDocuments } from '../ui';

type Version = { name?: string; path?: string; before: string; after: string; whole: boolean };

export class ChangeViews {
  /** Approvals whose change is open in a diff editor. */
  private readonly shown = new Set<string>();

  constructor(
    private readonly diffs: DiffDocuments,
    private readonly model: () => ChatModel,
    private readonly workspaceFolder: () => string,
  ) {}

  private workspace(): string {
    return this.model().workspace ?? this.workspaceFolder();
  }

  isShown(id: string): boolean {
    return this.shown.has(id);
  }

  /** Close an approval's diff editor and forget it. */
  close(id: string): void {
    if (this.shown.has(id)) void this.diffs.close(id);
    this.forget(id);
  }

  forget(id: string): void {
    this.shown.delete(id);
    this.diffs.forget(id);
  }

  forgetAll(): void {
    for (const id of [...this.shown]) this.forget(id);
  }

  /** A pending approval's change in VS Code's diff editor, every file of it. */
  async viewApproval(id: string): Promise<void> {
    const approval = this.model().approvals.find((item) => item.id === id);
    if (!approval?.diff?.length) return;
    const files = await Promise.all(approval.diff.map((file) => this.fileVersions(file, 'proposed')));
    this.shown.add(id);
    await this.diffs.show(id, approval.title, files.map((file, index) => ({ ...file, name: file.name ?? fileNameIn(approval.title, approval.detail) ?? `change ${index + 1}` })));
  }

  /** A file's whole text before and after a change, where the file on disk
   * lets the hunks be placed: a proposed change applies to the file as it
   * is; a made one is undone from it. When a hunk does not place cleanly, or
   * the diff was cut short, the hunks themselves. */
  private async fileVersions(file: FileDiff, state: 'proposed' | 'made'): Promise<Version> {
    const hunks = fileHunks(file);
    const path = file.path ? (isAbsolute(file.path) ? file.path : join(this.workspace(), file.path)) : undefined;
    const current = path ? await readFile(path, 'utf8').catch(() => undefined) : undefined;
    const name = file.path?.split(/[\\/]/).pop();
    if (state === 'made' && file.change === 'add' && current !== undefined) return { name, path, before: '', after: current, whole: true };
    if (current !== undefined && !file.omitted) {
      if (state === 'proposed') {
        const after = applyHunks(current, hunks);
        if (after !== undefined) return { name, path, before: current, after, whole: true };
      } else {
        const before = applyHunks(current, hunks.map((hunk) => ({ before: hunk.after, after: hunk.before })));
        if (before !== undefined) return { name, path, before, after: current, whole: true };
      }
    }
    return {
      name, path, whole: false,
      before: hunks.map((hunk) => hunk.before.join('\n')).join('\n⋮\n'),
      after: hunks.map((hunk) => hunk.after.join('\n')).join('\n⋮\n'),
    };
  }

  /** A tool row's change, by the turn it belongs to (none: the running one). */
  private changeOf(key: string, userIndex: number | undefined): FileDiff[] | undefined {
    const model = this.model();
    const activities = userIndex === undefined ? model.live?.activities : model.traces.find((trace) => trace.userIndex === userIndex)?.activities;
    return activities?.find((activity) => activity.key === key)?.diff;
  }

  /** A change the agent made, in the diff editor. */
  async viewChange(key: string, userIndex: number | undefined): Promise<void> {
    const diff = this.changeOf(key, userIndex);
    if (!diff?.length) return;
    const files = await Promise.all(diff.map((file) => this.fileVersions(file, 'made')));
    const id = `made-${userIndex ?? 'live'}-${key.replace(/[^\w-]+/g, '_')}`;
    await this.diffs.show(id, 'Change', files.map((file, index) => ({ ...file, name: file.name ?? `change ${index + 1}` })), true);
  }

  /** Undo a change the agent made, as one edit VS Code can itself undo --
   * only where every file of it still places cleanly. */
  async revertChange(key: string, userIndex: number | undefined): Promise<void> {
    const diff = this.changeOf(key, userIndex);
    if (!diff?.length) return;
    const files = await Promise.all(diff.map(async (file) => ({ ...(await this.fileVersions(file, 'made')), created: file.change === 'add' })));
    await undoFiles(files, 'this change', (names) => `Undo ClikCode's change to ${names}?`, 'Undo Change');
  }

  /** Every file a finished turn changed, as it was before the turn and as
   * it is now (unwindChanges): whole where all its changes still place. */
  private async turnFiles(userIndex: number): Promise<Array<{ name: string; path: string; before: string; after: string; whole: boolean; created: boolean }>> {
    const trace = this.model().traces.find((item) => item.userIndex === userIndex);
    const workspace = this.workspace();
    return Promise.all([...turnChanges(trace?.activities ?? [])].map(async ([file, changes]) => {
      const path = isAbsolute(file) ? file : join(workspace, file);
      const current = await readFile(path, 'utf8').catch(() => undefined);
      const unwound = unwindChanges(current, changes);
      return { name: file.split(/[\\/]/).pop() || file, path, before: unwound.before, after: current ?? '', whole: unwound.whole, created: unwound.created };
    }));
  }

  /** All of a turn's changes in the diff editor at once -- the multi-file
   * changes editor where it touched several files. */
  async viewTurn(userIndex: number): Promise<void> {
    const files = await this.turnFiles(userIndex);
    if (!files.length) return;
    await this.diffs.show(`turn-${userIndex}`, 'Changes', files, true);
  }

  /** Every change a turn made undone as one edit, after a modal confirm;
   * refused when any of its files changed since. */
  async revertTurn(userIndex: number): Promise<void> {
    const files = await this.turnFiles(userIndex);
    if (!files.length) return;
    await undoFiles(files, "this turn's changes", (names) => `Undo all of ClikCode's changes in this turn (${files.length} file${files.length === 1 ? '' : 's'}: ${names})?`, 'Undo All');
  }
}

/** Files put back as they were, as one WorkspaceEdit VS Code can itself
 * undo: a file the agent created is deleted. Nothing is touched unless
 * every file still places cleanly. */
async function undoFiles(files: ReadonlyArray<{ name?: string; path?: string; before: string; whole: boolean; created: boolean }>, what: string, question: (names: string) => string, action: string): Promise<void> {
  const stale = files.filter((item) => !item.whole || !item.path);
  if (stale.length) {
    void vscode.window.showWarningMessage(userError(`undo ${what}`, `${stale.map((item) => item.name ?? 'a file').join(', ')} changed since`));
    return;
  }
  const names = files.map((item) => item.name).join(', ');
  const choice = await vscode.window.showWarningMessage(question(names), { modal: true, detail: 'You can redo it with Undo in the editor.' }, action);
  if (choice !== action) return;
  const edit = new vscode.WorkspaceEdit();
  for (const item of files) {
    const uri = vscode.Uri.file(item.path!);
    if (item.created) { edit.deleteFile(uri, { ignoreIfNotExists: true }); continue; }
    const document = await vscode.workspace.openTextDocument(uri);
    edit.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), item.before);
  }
  if (!(await vscode.workspace.applyEdit(edit))) { void vscode.window.showErrorMessage(userError(`undo the change to ${names}`)); return; }
  await Promise.all(files.filter((item) => !item.created).map(async (item) => (await vscode.workspace.openTextDocument(vscode.Uri.file(item.path!))).save()));
}
