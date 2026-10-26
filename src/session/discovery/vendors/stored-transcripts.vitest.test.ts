import { it, expect, vi } from 'vitest';
import { readFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import * as zlib from 'node:zlib';
import type { AiLocalHarnessDefinition } from '../../../harness/definition.js';
const capture = vi.hoisted(() => vi.fn());
vi.mock('../../../harness/transport/native/command.js', async (original) => ({
  ...await original<typeof import('../../../harness/transport/native/command.js')>(), captureNativeHarnessOutput: capture,
}));
import { aiderTranscript, piTranscript, readAmpTranscript, readAntigravityTranscript, readOpenClawTranscript } from './stored-transcripts.js';
const golden = (name: string) => readFile(fileURLToPath(new URL(`./__golden__/${name}`, import.meta.url)), 'utf8');
const harness = { command: 'fake' } as AiLocalHarnessDefinition;

it('reads the vendor-verified Aider and Pi fixtures, ignoring tool-result roles', async () => {
  const aider = aiderTranscript(await golden('aider.history.md'));
  const pi = piTranscript((await golden('pi.jsonl')).trim().split('\n').map((line) => JSON.parse(line)));
  for (const messages of [aider, pi]) {
    expect(messages.filter((message) => message.role === 'user')).toHaveLength(2);
    expect(messages[0]?.content).toContain('PELICAN-73');
    expect(messages.at(-1)?.content).toContain('Fixed the typo');
  }
});

it('follows Pi parent links instead of importing a discarded sibling branch', () => {
  const entry=(id:string,parentId:string|null,text:string)=>({id,parentId,type:'message',message:{role:'user',content:text}});
  expect(piTranscript([entry('a',null,'root'),entry('b','a','discarded'),entry('c','a','selected')]).map((message)=>message.content)).toEqual(['root','selected']);
});

it('uses the selected Amp account environment for the official JSON export', async () => {
  capture.mockResolvedValue(JSON.stringify({messages:[{role:'user',content:[{type:'text',text:'old prompt'}]},{role:'assistant',content:[{type:'text',text:'old answer'}]}]}));
  expect(await readAmpTranscript(harness,'T-id','/workspace',{HOME:'/profile'})).toEqual([{role:'user',content:'old prompt'},{role:'assistant',content:'old answer'}]);
  expect(capture).toHaveBeenCalledWith(harness,['threads','export','T-id'],{HOME:'/profile'},undefined,'/workspace');
});

it('reads the observed Antigravity protobuf store without writing it', async () => {
  const {DatabaseSync}=await import('node:sqlite');
  const home=await mkdtemp(join(tmpdir(),'clikcode-agy-read-'));
  try {
    const folder=join(home,'.gemini','antigravity-cli','conversations'); await mkdir(folder,{recursive:true});
    const db=new DatabaseSync(join(folder,'native.db'));
    db.exec('CREATE TABLE steps (idx INTEGER, step_type INTEGER, step_payload BLOB)');
    const fixture=JSON.parse(await golden('antigravity.rows.json'));
    for(const row of fixture.steps)db.prepare('INSERT INTO steps VALUES (?,?,?)').run(row.idx,row.stepType,Buffer.from(row.payload,'hex'));
    db.close();
    const messages=await readAntigravityTranscript(harness,'native','/workspace',{HOME:home});
    expect(messages.filter((message)=>message.role==='user')).toHaveLength(2);
    expect(messages[0]?.content).toContain('PELICAN-73');
    expect(messages.at(-1)?.content).toContain('Fixed the typo');
  } finally {await rm(home,{recursive:true,force:true});}
});

it('reads OpenClaw text and compressed transcript events from the selected profile', async () => {
  const {DatabaseSync}=await import('node:sqlite');
  const home=await mkdtemp(join(tmpdir(),'clikcode-openclaw-read-'));
  try {
    const folder=join(home,'agents','main','agent');await mkdir(folder,{recursive:true});
    const db=new DatabaseSync(join(folder,'openclaw-agent.sqlite'));
    db.exec('CREATE TABLE transcript_events (session_id TEXT,seq INTEGER,event_json TEXT,event_zstd BLOB,event_utf8_bytes INTEGER)');
    const entries=(await golden('openclaw.jsonl')).trim().split('\n');
    for(const [index,text] of entries.entries()){
      const compressed=index===entries.length-1 && zlib.zstdCompressSync;
      db.prepare('INSERT INTO transcript_events VALUES (?,?,?,?,?)').run('native',index,compressed?null:text,compressed?zlib.zstdCompressSync(text):null,Buffer.byteLength(text));
    }
    db.close();
    const messages=await readOpenClawTranscript(harness,'native','/workspace',{OPENCLAW_STATE_DIR:home});
    expect(messages.filter((message)=>message.role==='user')).toHaveLength(2);
    expect(messages[0]?.content).toContain('PELICAN-73');
    expect(messages.at(-1)?.content).toContain('Fixed the typo');
  } finally {await rm(home,{recursive:true,force:true});}
});
