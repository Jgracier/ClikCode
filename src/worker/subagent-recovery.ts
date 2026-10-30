/** Carry just a cut-off Claude agent's own history to the account its conversation moved to, so
 * the vendor can resume it as it was (SendMessage to its id). Only an optimisation, and only where
 * it can apply: a Claude agent and a Claude profile on each side. True when the agent's history is
 * there to resume. Every other cut-off agent -- another harness, or a Claude one whose files cannot
 * be carried -- is taken up again from its replay (handed-off-work.ts formatEndedWork): the task, its
 * progress and its saved transcript. Other children may still be running in either profile: never
 * replace their tree. */
import { dirname, join, relative } from 'node:path';
import { stat } from 'node:fs/promises';
import type { AiHarnessAccount } from '../harness/definition.js';
import type { EndedWork } from '../harness/transport/handoff-work.js';
import type { HarnessSession } from '../session/model.js';
import { nativeProfileEnvironment } from '../harness/transport/profile-environment.js';
import { claudeSessionStore } from '../session/discovery/vendors/claude-store.js';
import { placeArtifact } from '../session/carry-artifact.js';

export async function carryBlockedSubagent(
  work: EndedWork, session: HarnessSession, source: AiHarnessAccount | undefined, target: AiHarnessAccount | undefined,
): Promise<boolean> {
  if (session.nativeHarness !== 'claude' || !source || !target || source.id === target.id
    || !session.nativeSessionId || !session.workspace || !/^[\w-]+$/.test(work.id)) return false;
  const from = nativeProfileEnvironment(source.nativeProfile);
  const to = nativeProfileEnvironment(target.nativeProfile);
  const sourceRoot = claudeSessionStore.root(from);
  const targetRoot = claudeSessionStore.root(to);
  if (!sourceRoot || !targetRoot) return false;
  if (sourceRoot === targetRoot) return true;
  const parent = await claudeSessionStore.locate!(sourceRoot, work.nativeSessionId ?? session.nativeSessionId, session.workspace, from);
  if (!parent) return false;
  const sourceDir = join(parent.path.slice(0, -'.jsonl'.length), 'subagents');
  const targetDir = join(targetRoot, relative(sourceRoot, dirname(parent.path)), session.nativeSessionId, 'subagents');
  const transcript = `agent-${work.id}.jsonl`;
  if (!await stat(join(sourceDir, transcript)).then((entry) => entry.isFile(), () => false)) return false;
  // The identity sidecar is optional in old Claude versions.
  const metadata = `agent-${work.id}.meta.json`;
  if (await stat(join(sourceDir, metadata)).then((entry) => entry.isFile(), () => false)) {
    await placeArtifact(join(sourceDir, metadata), join(targetDir, metadata));
  }
  return placeArtifact(join(sourceDir, transcript), join(targetDir, transcript));
}
