import { it, expect } from 'vitest';
import { mkdtemp, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { queryAcp, acpDiscoverySession } from './acp-query.js';
import { readAcpTranscript } from '../../session/discovery/acp-transcript.js';
import type { AiLocalHarnessDefinition } from '../definition.js';

async function fake(run: (binary: string, log: string, home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'clikcode-discovery-lifecycle-'));
  const binary = join(home, 'agent.mjs');
  const log = join(home, 'calls.jsonl');
  await writeFile(binary, `#!${process.execPath}
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const emit = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
createInterface({input:process.stdin}).on('line',(line)=>{
 const message=JSON.parse(line); appendFileSync(${JSON.stringify(log)},line+'\\n');
 if(message.method==='silent')return;
 if(message.method==='session/load') {
  for(let i=0;i<260;i++)emit({method:'session/update',params:{sessionId:message.params.sessionId,update:{sessionUpdate:i%2?'agent_message_chunk':'user_message_chunk',content:{type:'text',text:String(i)}}}});
 }
 emit({jsonrpc:'2.0',id:message.id,result:message.method==='initialize'?{agentCapabilities:{loadSession:true,sessionCapabilities:{delete:{}}}}:message.method==='session/new'?{sessionId:'owned-1'}:{}});
});`);
  await chmod(binary, 0o755);
  try { await run(binary, log, home); } finally { await rm(home, {recursive:true,force:true}); }
}

it('deletes only a newly created probe session, also when metadata processing fails', async () => {
  await fake(async (binary, log) => {
    const harness = {command:'fake-probe'} as AiLocalHarnessDefinition;
    const result = await queryAcp(binary, [], {}, async (request) => {
      await acpDiscoverySession(request);
      throw new Error('bad metadata');
    }, 1000, {discovery:harness});
    expect(result).toBeUndefined();
    const calls = (await readFile(log,'utf8')).trim().split('\n').map((line)=>JSON.parse(line));
    expect(calls.map((call)=>call.method)).toEqual(['initialize','session/new','session/delete']);
    expect(calls.at(-1).params.sessionId).toBe('owned-1');
  });
});

it('bounds a silent metadata request and releases its process', async () => {
  await fake(async (binary) => {
    const start=Date.now();
    expect(await queryAcp(binary, [], {}, (request)=>request('silent'), 100)).toBeUndefined();
    expect(Date.now()-start).toBeLessThan(3000);
  });
});

it('imports all replayed messages without creating or deleting the adopted thread', async () => {
  await fake(async (binary, log, home) => {
    const harness={command:'fake-probe',binary,acp:{argv:[]}} as unknown as AiLocalHarnessDefinition;
    const messages=await readAcpTranscript(harness,'existing',home);
    expect(messages).toHaveLength(260);
    expect(messages[0]).toEqual({role:'user',content:'0'});
    expect(messages.at(-1)).toEqual({role:'assistant',content:'259'});
    const calls=(await readFile(log,'utf8')).trim().split('\n').map((line)=>JSON.parse(line));
    expect(calls.map((call)=>call.method)).toEqual(['initialize','session/load']);
  });
});
