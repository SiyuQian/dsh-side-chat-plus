import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SideChatService, JsonStore } from '../src/service.js';

async function fixture(overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'side-chat-test-'));
  const calls = [];
  const adapter = {
    async parentContext() { return { text: 'USER: design question\nASSISTANT: parent answer', cwd: dir }; },
    async models() { return [{provider:'test',model:'model',name:'Test'}]; },
    async run(record, text, {onText}) { calls.push(structuredClone(record)); onText('answer'); return 'answer'; },
    async dispose() {}, ...overrides,
  };
  const service = await SideChatService.open(new JsonStore(dir), adapter);
  return {service,dir,calls};
}
const request = (extra = {}) => ({parentId:'parent-A',mode:'discuss',model:{provider:'test',model:'model'},...extra});
const tick = () => new Promise(resolve => setImmediate(resolve));
async function done(service, id) {
  for (let n=0;n<100;n++) {
    const record = await service.get({id,parentId:'parent-A'});
    if (record.status === 'idle') return record;
    await tick();
  }
  throw new Error('test run did not settle');
}

test('discussion cannot request writable permissions or inherit hidden context by default', async () => {
  const {service} = await fixture();
  await assert.rejects(service.create(request({permission:'workspace-write'})), /permission/);
  const record = await service.create(request());
  assert.equal(record.permission,'none');
  assert.equal(record.contextChars,0);
});

test('Agent defaults read-only and owns a frozen copy of parent context', async () => {
  const {service,calls} = await fixture();
  const chat = await service.create(request({mode:'agent'}));
  assert.equal(chat.permission,'read-only');
  assert.ok(chat.contextChars > 0);
  await service.send({id:chat.id,parentId:'parent-A',text:'inspect'});
  await done(service,chat.id);
  assert.equal(calls[0].context,'USER: design question\nASSISTANT: parent answer');
  assert.equal(calls[0].messages.filter(m=>m.role==='user').length,0,'adapter receives prior history only');
});

test('writable Agent requires explicit confirmation and rejects arbitrary permissions', async () => {
  const {service} = await fixture();
  await assert.rejects(service.create(request({mode:'agent',permission:'workspace-write'})),/confirm/);
  await assert.rejects(service.create(request({mode:'agent',permission:'danger-full-access',confirmWrite:true})),/permission/);
  const chat = await service.create(request({mode:'agent',permission:'workspace-write',confirmWrite:true}));
  assert.equal(chat.permission,'workspace-write');
});

test('save and restore preserves both modes, multi-turn history, and rejects foreign parent access', async () => {
  const {service,dir} = await fixture();
  const chat = await service.create(request({selectedText:'selected passage'}));
  await service.send({id:chat.id,parentId:'parent-A',text:'explain'});
  const complete = await done(service,chat.id);
  assert.deepEqual(complete.messages.map(m=>[m.role,m.text,m.status]),[['user','explain','complete'],['assistant','answer','complete']]);
  await service.dispose();
  const restored = await SideChatService.open(new JsonStore(dir), {dispose:async()=>{}});
  assert.equal((await restored.list({parentId:'parent-A'})).length,1);
  assert.equal((await restored.get({id:chat.id,parentId:'parent-A'})).selectedText,'selected passage');
  await assert.rejects(restored.get({id:chat.id,parentId:'parent-B'}),/not found/);
  await assert.rejects(restored.get({id:'../../secret',parentId:'parent-A'}),/id/);
});

test('duplicate sends are rejected while running and stop retains partial output as stopped', async () => {
  let started;
  const ready = new Promise(resolve=>{started=resolve;});
  const {service} = await fixture({run:async (record,text,{signal,onText})=>{
    onText('partial'); started();
    await new Promise((resolve,reject)=>{if(signal.aborted) reject(signal.reason); else signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});
  }});
  const chat = await service.create(request());
  await service.send({id:chat.id,parentId:'parent-A',text:'first'});
  await ready;
  await assert.rejects(service.send({id:chat.id,parentId:'parent-A',text:'second'}),/running/);
  const stopped = await service.stop({id:chat.id,parentId:'parent-A'});
  assert.equal(stopped.status,'idle');
  assert.equal(stopped.messages.at(-1).text,'partial');
  assert.equal(stopped.messages.at(-1).status,'stopped');
});

test('provider failures are recorded without replacing completed history', async () => {
  const {service} = await fixture({run:async()=>{throw new Error('provider unavailable');}});
  const chat = await service.create(request());
  await service.send({id:chat.id,parentId:'parent-A',text:'hello'});
  const record = await done(service,chat.id);
  assert.match(record.error,/provider unavailable/);
  assert.equal(record.messages.at(-1).status,'error');
});

test('crash recovery changes running replies to interrupted and never reruns them', async () => {
  const {dir} = await fixture();
  const id = '11111111-1111-4111-8111-111111111111';
  await writeFile(join(dir,`${id}.json`),JSON.stringify({schema:1,id,parentId:'parent-A',mode:'discuss',permission:'none',model:{provider:'p',model:'m'},context:'',cwd:dir,selectedText:'',title:'saved',messages:[{role:'assistant',text:'partial',status:'running'}],status:'running',createdAt:1,updatedAt:1}));
  const service = await SideChatService.open(new JsonStore(dir),{dispose:async()=>{}});
  const chat = await service.get({id,parentId:'parent-A'});
  assert.equal(chat.status,'idle');
  assert.equal(chat.messages[0].status,'stopped');
});

test('corrupt saved data fails closed and remains available for manual recovery', async () => {
  const dir = await mkdtemp(join(tmpdir(),'side-chat-corrupt-'));
  const file = join(dir,'11111111-1111-4111-8111-111111111111.json');
  await writeFile(file,'{broken');
  await assert.rejects(SideChatService.open(new JsonStore(dir),{}), /saved|JSON/i);
  assert.equal(await readFile(file,'utf8'),'{broken');
});

test('client snapshots never expose raw inherited history or workspace paths', async () => {
  const {service} = await fixture();
  const record = await service.create(request({mode:'agent'}));
  assert.equal('context' in record,false);
  assert.equal('cwd' in record,false);
  assert.equal('schema' in record,false);
});

test('oversized context and blank messages are rejected without model calls', async () => {
  const {service,calls} = await fixture({parentContext:async()=>({text:'x'.repeat(300000),cwd:'/tmp'})});
  await assert.rejects(service.create(request({inheritContext:true})),/context/i);
  const record=await service.create(request());
  await assert.rejects(service.send({id:record.id,parentId:'parent-A',text:'  '}),/text/);
  assert.equal(calls.length,0);
});

test('restore drops unknown fields and refuses unbounded saved record contents',async()=>{
  const {service,dir}=await fixture();
  const chat=await service.create(request());
  const file=join(dir,`${chat.id}.json`);
  const stored=JSON.parse(await readFile(file,'utf8'));stored.untrustedSecret='must not expose';
  await writeFile(file,JSON.stringify(stored));
  const restored=await SideChatService.open(new JsonStore(dir),{dispose:async()=>{}});
  assert.equal('untrustedSecret' in await restored.get({id:chat.id,parentId:'parent-A'}),false);
  stored.selectedText='s'.repeat(64001);await writeFile(file,JSON.stringify(stored));
  await assert.rejects(SideChatService.open(new JsonStore(dir),{}),/saved|selected/i);
  await writeFile(file,' '.repeat(6*1024*1024));
  await assert.rejects(SideChatService.open(new JsonStore(dir),{}),/size|large/i);
});

test('delete only removes a record owned by the supplied parent', async()=>{
  const {service,dir}=await fixture();
  const chat=await service.create(request());
  await assert.rejects(service.delete({id:chat.id,parentId:'other'}),/not found/);
  assert.deepEqual(await service.delete({id:chat.id,parentId:'parent-A'}),{deleted:true});
  assert.equal((await readdir(dir)).filter(f=>f.endsWith('.json')).length,0);
});
