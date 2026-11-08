import test from 'node:test';
import assert from 'node:assert/strict';
import {SideChatService} from '../src/service.js';

function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {resolve,promise};}
const createRequest={parentId:'p',mode:'discuss',model:{provider:'p',model:'m'}};

test('stop waits for durable send admission and no model call starts after stop returns',async()=>{
  const gate=deferred(); let blocked=false, calls=0;
  const store={load:async()=>[],save:async()=>{if(blocked)await gate.promise;},remove:async()=>{}};
  const service=await SideChatService.open(store,{parentContext:async()=>({text:'',cwd:'/tmp'}),run:async()=>{calls++;return 'unexpected';},dispose:async()=>{}});
  const chat=await service.create(createRequest);
  blocked=true;
  const send=service.send({id:chat.id,parentId:'p',text:'q'});
  let stopped=false;
  const stop=service.stop({id:chat.id,parentId:'p'}).then(r=>{stopped=true;return r;});
  await new Promise(r=>setImmediate(r));
  assert.equal(stopped,false);
  gate.resolve();
  await send;
  const result=await stop;
  assert.equal(result.status,'idle');
  assert.equal(calls,0);
});

test('deletion prevents new sends from reviving a removed discussion',async()=>{
  const gate=deferred(); const closing=deferred(); let calls=0;
  const service=await SideChatService.open({load:async()=>[],save:async()=>{},remove:async()=>{}},{parentContext:async()=>({text:'',cwd:'/tmp'}),run:async()=>{calls++;return 'answer';},close:async()=>{closing.resolve();await gate.promise;},dispose:async()=>{}});
  const chat=await service.create(createRequest);
  const deletion=service.delete({id:chat.id,parentId:'p'}); await closing.promise;
  await assert.rejects(service.send({id:chat.id,parentId:'p',text:'revive'}),/delet/);
  gate.resolve(); await deletion;
  assert.equal(calls,0);
});

test('dispose waits for initial durable admission before releasing the adapter',async()=>{
  const gate=deferred(); let blocked=false, disposed=false;
  const service=await SideChatService.open({load:async()=>[],save:async()=>{if(blocked)await gate.promise;}},{parentContext:async()=>({text:'',cwd:'/tmp'}),run:async()=>'',dispose:async()=>{disposed=true;}});
  const chat=await service.create(createRequest); blocked=true;
  const send=service.send({id:chat.id,parentId:'p',text:'q'});
  const disposal=service.dispose();
  await new Promise(r=>setImmediate(r));
  assert.equal(disposed,false);
  gate.resolve();await send;await disposal;
  assert.equal(disposed,true);
});
