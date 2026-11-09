import { expect, it } from 'vitest';
import { localHarnessForCommand } from '@clikcode/router/ai-local-harness';
import { runVendorCliAttempt } from './vendor-cli-attempt.js';
import { LiveTurnInputBroker, type LiveTurnInputResult } from './live-input.js';
import { fakeLedger } from './test-support/live-ledger.js';
import type { HarnessSession } from '../session/model.js';

it('pipes Amp input, waits out a tool for a live steer, and journals its acknowledgement', async () => {
  const script = `
    const send = (value) => process.stdout.write(JSON.stringify({session_id:'T-native',...value})+'\\n');
    const assistant = (content,stop_reason) => send({type:'assistant',message:{role:'assistant',content,stop_reason}});
    let buffer=''; let first=true; let toolDone=false;
    process.stdin.on('data',data=>{buffer+=data;let at;while((at=buffer.indexOf('\\n'))>=0){
      const message=JSON.parse(buffer.slice(0,at));buffer=buffer.slice(at+1);
      if(typeof message.message?.content?.[0]?.text!=='string')process.exit(7);
      send(message);
      if(first){first=false;
        assistant([{type:'tool_use',id:'call1',name:'Bash',input:{command:'test'}}],'tool_use');
        setTimeout(()=>{toolDone=true;send({type:'user',message:{role:'user',content:[{type:'tool_result',tool_use_id:'call1',content:'TOOL_DONE'}]}});},40);
      }else{
        if(message.steer!==true)process.exit(8);
        if(!toolDone)process.exit(9);
        assistant([{type:'text',text:'STEERED'}],'end_turn');
      }
    }});
    process.stdin.on('end',()=>{send({type:'result',subtype:'success',result:'STEERED',is_error:false});});
  `;
  const amp = localHarnessForCommand('amp')!;
  const harness = { ...amp, binary: process.execPath, turn: { ...amp.turn!, startArgv: ['-e', script], mcpConfigArgv: undefined } };
  const session = { id: 'amp-test', route: 'local', nativeHarness: 'amp', workspace: process.cwd() } as HarnessSession;
  const broker = new LiveTurnInputBroker();
  const { ledger, queue, steered } = fakeLedger();
  broker.bindLedger(ledger);
  let typed: Promise<LiveTurnInputResult> | undefined;
  const stop = new AbortController();
  // Only a guard against a hang: starting the fake Amp took over 3 s on a busy machine.
  const timer = setTimeout(() => stop.abort(), 20_000);
  try {
    const result = await runVendorCliAttempt({ harness, session, turnText: 'first prompt', model: null, environment: {}, images: [], signal: stop.signal,
      run: { liveInput: broker }, checkpoint: { touch: () => undefined, persistNow: async () => undefined } as never,
      onOutputStart: () => undefined, onStreamError: () => undefined,
      sharedObserver: { onActivity: (event) => { if (event.id === 'call1' && event.kind === 'tool-start' && !typed) typed = broker.submit('change answer', 'steer1', { steer: true }); } },
    });
    expect(result.text).toBe('STEERED');
    expect(result.nativeSessionId).toBe('T-native');
    expect(typed).toBeDefined();
    const submission = await typed!;
    // It never reached Amp while the tool ran (the fake exits 9 if it did), and went into the turn once Amp echoed it: queued first
    // when ClikCode saw the tool open, straight in when a busy machine only read the tool's start and end together.
    expect(['queued', 'steered']).toContain(submission.disposition);
    expect(steered).toEqual([expect.objectContaining({ id: 'steer1', text: 'change answer' })]);
    expect(queue).toEqual([]);
  } finally { clearTimeout(timer); stop.abort(); }
}, 30_000);
