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

/** Where Claude saved this agent's own history (`agent-<id>.jsonl` under its conversation), or undefined where there is none to
 * resume: not a Claude conversation, no such file, or an id that is not a plain agent id. */
export async function locateAgentTranscript(work: Pick<EndedWork, 'id' | 'nativeSessionId'>, session: HarnessSession, account: AiHarnessAccount | undefined): Promise<string | undefined> {
  if (session.nativeHarness !== 'claude' || !account || !session.nativeSessionId || !session.workspace || !/^[\w-]+$/.test(work.id)) return undefined;
  const environment = nativeProfileEnvironment(account.nativeProfile);
  const root = claudeSessionStore.root(environment);
  if (!root) return undefined;
  const parent = await claudeSessionStore.locate!(root, work.nativeSessionId ?? session.nativeSessionId, session.workspace, environment);
  if (!parent) return undefined;
  const file = join(parent.path.slice(0, -'.jsonl'.length), 'subagents', `agent-${work.id}.jsonl`);
  return await stat(file).then((entry) => entry.isFile(), () => false) ? file : undefined;
}

export async function carryBlockedSubagent(
  work: EndedWork, session: HarnessSession, source: AiHarnessAccount | undefined, target: AiHarnessAccount | undefined,
): Promise<boolean> {
  // The same account: nothing to carry, and the agent resumes as it was when its history is there.
  if (source && target && source.id === target.id) return (await locateAgentTranscript(work, session, source)) !== undefined;
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
