import test from 'node:test';
import assert from 'node:assert/strict';
import {SideChatService} from '../src/service.js';
const defer=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve:()=>resolve()};};
const req={parentId:'p',mode:'discuss',model:{provider:'p',model:'m'}};
const tick=()=>new Promise(r=>setImmediate(r));

test('unload drains parent-context reads before disposing its DSH adapter',async()=>{
  const gate=defer();let disposed=false;
  const service=await SideChatService.open({load:async()=>[],save:async()=>{}},{parentContext:async()=>{await gate.promise;return {text:'',cwd:'/tmp'};},dispose:async()=>{disposed=true;}});
  const creating=service.create(req);
  const failed=assert.rejects(creating,/unloading/);
  const closing=service.dispose();await tick();assert.equal(disposed,false);
  gate.resolve();await failed;await closing;assert.equal(disposed,true);
});

test('unload drains a pending deletion before disposing the same adapter',async()=>{
  const gate=defer(),started=defer();let removed=false,disposed=false;
  const service=await SideChatService.open({load:async()=>[],save:async()=>{},remove:async()=>{removed=true;}},{parentContext:async()=>({text:'',cwd:'/tmp'}),close:async()=>{started.resolve();await gate.promise;},dispose:async()=>{disposed=true;}});
  const chat=await service.create(req);const deleting=service.delete({id:chat.id,parentId:'p'});await started.promise;
  const closing=service.dispose();await tick();assert.equal(disposed,false);
  gate.resolve();await deleting;await closing;assert.equal(removed,true);assert.equal(disposed,true);
});
