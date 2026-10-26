import { it, expect } from 'vitest';
import { runAcpTurn } from './acp-client.js';
import { LiveSettings } from '../../turn/live-settings.js';

it('applies an explicit undefined plan-mode change as leaving plan mode during a prompt', async () => {
  const settings = new LiveSettings({ route: 'local', model: null, effort: 'auto', planMode: true, permissionMode: 'ask' });
  const agent = `
    const send = (m) => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...m})+'\\n');
    let prompt; let buffer='';
    process.stdin.on('data',data=>{buffer+=data;let at;while((at=buffer.indexOf('\\n'))>=0){
      const m=JSON.parse(buffer.slice(0,at));buffer=buffer.slice(at+1);
      if(m.method==='initialize')send({id:m.id,result:{agentCapabilities:{}}});
      else if(m.method==='session/new')send({id:m.id,result:{sessionId:'plan',modes:{currentModeId:'plan',availableModes:[{id:'plan',name:'Plan'},{id:'default',name:'Default'}]}}});
      else if(m.method==='session/prompt'){
        prompt=m.id;
        send({method:'session/update',params:{sessionId:'plan',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Planning'}}}});
      }else if(m.method==='session/set_mode'){
        if(m.params.modeId!=='default')process.exit(5);
        send({id:m.id,result:{}});send({id:prompt,result:{stopReason:'end_turn'}});
      }
    }});
  `;
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), 2000);
  try {
    const result = await runAcpTurn({ binary: process.execPath, command: 'fake', argv: ['-e', agent], cwd: process.cwd(), environment: {},
      prompt: 'go', permissionMode: 'ask', planMode: true, liveSettings: settings, signal: stop.signal,
      acp: { planModeId: 'plan', permissionModeIds: { ask: 'default' } },
      onResponseDelta: () => settings.apply({ planMode: undefined }),
    });
    expect(result.text).toBe('Planning');
  } finally { clearTimeout(timer); stop.abort(); }
});

it('changes a running ACP model and effort through native controls without cancelling the prompt', async () => {
  const settings = new LiveSettings({ route: 'local', model: 'one', effort: 'low', permissionMode: 'ask' });
  const agent = `
    const send = (m) => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...m})+'\\n');
    const options=[{id:'model',currentValue:'one',options:[{value:'one'},{value:'two'}]},{id:'effort',currentValue:'low',options:[{value:'low'},{value:'high'}]}];
    let prompt; let count=0; let buffer='';
    process.stdin.on('data',(data)=>{buffer+=data;let end;while((end=buffer.indexOf('\\n'))>=0){
      const m=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);
      if(m.method==='session/cancel') process.exit(5);
      if(m.method==='initialize') send({id:m.id,result:{agentCapabilities:{}}});
      else if(m.method==='session/new') send({id:m.id,result:{sessionId:'live',configOptions:options}});
      else if(m.method==='session/prompt') {
        prompt=m.id;
        send({method:'session/update',params:{sessionId:'live',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Ready'}}}});
      } else if(m.method==='session/set_config_option') {
        options.find((o)=>o.id===m.params.configId).currentValue=m.params.value;
        send({id:m.id,result:{configOptions:options}});
        if(++count===2)send({id:prompt,result:{stopReason:'end_turn'}});
      }
    }});
  `;
  const models: string[] = [];
  const result = await runAcpTurn({
    binary:process.execPath,command:'fake',argv:['-e',agent],cwd:process.cwd(),environment:{},prompt:'go',permissionMode:'ask',model:'one',effort:'low',acp:{effortConfigId:'effort'},liveSettings:settings,
    onResponseDelta:()=>settings.apply({model:'two',effort:'high'}),
    onServedModel:(model)=>models.push(model),
  });
  expect(result.text).toBe('Ready');
  expect(models).toEqual(['two']);
});
