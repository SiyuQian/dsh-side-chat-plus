import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LIMIT = 256000;
function text(value, name, max = 64000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`Invalid ${name}`);
  return value;
}
function validId(id) { if (typeof id !== 'string' || !ID.test(id)) throw new Error('Invalid chat id'); return id; }
function clientRecord(record) {
  const {id,parentId,mode,permission,model,selectedText,title,messages,status,error,createdAt,updatedAt}=record;
  return structuredClone({id,parentId,mode,permission,model,selectedText,title,messages,status,...(error?{error}:{}),createdAt,updatedAt,contextChars:record.context.length});
}
function validateSaved(record, filename) {
  if (!record || record.schema !== 1 || `${validId(record.id)}.json` !== filename) throw new Error('Invalid saved chat identity');
  text(record.parentId, 'saved parent id', 256);
  if (!['discuss','agent'].includes(record.mode) || !['none','read-only','workspace-write'].includes(record.permission)) throw new Error('Invalid saved chat mode/permission');
  if (record.mode === 'discuss' && record.permission !== 'none' || record.mode === 'agent' && record.permission === 'none') throw new Error('Invalid saved chat permission');
  text(record.model?.provider, 'saved provider', 256); text(record.model?.model, 'saved model', 256);
  if (typeof record.context !== 'string' || record.context.length > LIMIT || typeof record.cwd !== 'string' || typeof record.selectedText !== 'string' || record.selectedText.length > 64000) throw new Error('Invalid saved context');
  if (!Array.isArray(record.messages) || record.messages.length > 128 || record.messages.some(m => !['user','assistant'].includes(m.role) || typeof m.text !== 'string' || m.text.length > LIMIT || !['complete','stopped','running','error'].includes(m.status))) throw new Error('Invalid saved messages');
  if (!['idle','running'].includes(record.status)) throw new Error('Invalid saved status');
  if(record.messages.reduce((sum,m)=>sum+m.text.length,0)>2*LIMIT) throw new Error('Saved history size exceeds limit');
  if(typeof record.title!=='string' || record.title.length>60 || !Number.isFinite(record.createdAt) || !Number.isFinite(record.updatedAt)) throw new Error('Invalid saved metadata');
  if(record.error!==undefined && (typeof record.error!=='string' || record.error.length>2000)) throw new Error('Invalid saved error');
  const model={provider:record.model.provider,model:record.model.model};
  if(record.model.reasoningEffort!==undefined) model.reasoningEffort=text(record.model.reasoningEffort,'saved reasoning effort',128);
  return {...clientRecord(record),schema:1,context:record.context,cwd:record.cwd,model,messages:record.messages.map(({role,text,status})=>({role,text,status}))};
}

/** Private per-profile JSON records; UUID-only paths and atomic replacement. */
export class JsonStore {
  constructor(directory) { this.directory = resolve(directory); this.writes = Promise.resolve(); }
  path(id) { return join(this.directory, `${validId(id)}.json`); }
  async load() {
    await mkdir(this.directory, {recursive:true, mode:0o700});
    const records = [];
    const filenames=(await readdir(this.directory)).filter(filename=>filename.endsWith('.json'));
    if(filenames.length>100) throw new Error('Saved chat count exceeds limit');
    for (const filename of filenames) {
      try {
        const path=join(this.directory,filename);
        if((await stat(path)).size>5*1024*1024) throw new Error('Saved chat size exceeds limit');
        records.push(validateSaved(JSON.parse(await readFile(path,'utf8')), filename));
      }
      catch (error) { throw new Error(`Cannot load saved Side Chat ${filename}: ${error.message}`); }
    }
    return records;
  }
  save(record) {
    const destination = this.path(record.id);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    const json = JSON.stringify(record);
    const operation = this.writes.then(async()=>{
      await writeFile(temporary,json,{mode:0o600,flag:'wx'});
      await rename(temporary,destination);
    });
    this.writes = operation.catch(()=>{});
    return operation;
  }
  async remove(id) {
    const destination = this.path(id);
    await this.writes;
    await unlink(destination);
  }
}

/** Owns immutable chat capabilities and serial model runs, never the parent Agent. */
export class SideChatService {
  constructor(store, adapter, records) {
    this.store=store; this.adapter=adapter;
    this.records=new Map(records.map(record=>[record.id,record]));
    this.jobs=new Map(); this.deletions=new Map(); this.admissions=new Set(); this.closed=false; this.creating=0;
  }
  static async open(store, adapter) {
    const records=await store.load();
    for (const record of records) {
      if (record.status !== 'running') continue;
      record.status='idle'; record.error='Previous run was interrupted; send a new message to continue.';
      for (const message of record.messages) if (message.status === 'running') message.status='stopped';
      await store.save(record);
    }
    return new SideChatService(store,adapter,records);
  }
  assertOpen() { if(this.closed) throw new Error('Side Chat is unloading'); }
  owned({id,parentId}) {
    validId(id); text(parentId,'parent id',256);
    const record=this.records.get(id);
    if (!record || record.parentId !== parentId) throw new Error('Chat not found');
    return record;
  }
  track(operation) {
    this.admissions.add(operation);
    const cleanup=()=>this.admissions.delete(operation);
    void operation.then(cleanup,cleanup);
    return operation;
  }
  async models() { this.assertOpen(); return this.track(this.adapter.models()); }
  async list({parentId}) {
    this.assertOpen(); text(parentId,'parent id',256);
    return [...this.records.values()].filter(r=>r.parentId===parentId).sort((a,b)=>b.updatedAt-a.updatedAt).map(clientRecord);
  }
  async get(request) { this.assertOpen(); return clientRecord(this.owned(request)); }
  create(request) {
    return this.track(this.createRecord(request));
  }
  async createRecord(request) {
    this.assertOpen();
    const parentId=text(request.parentId,'parent id',256);
    if (!['discuss','agent'].includes(request.mode)) throw new Error('Invalid mode');
    const mode=request.mode;
    const permission=request.permission ?? (mode==='agent'?'read-only':'none');
    if (mode==='discuss' ? !['none','read-only'].includes(permission) : !['read-only','workspace-write'].includes(permission)) throw new Error('Invalid permission');
    if (permission==='workspace-write' && request.confirmWrite!==true) throw new Error('Please confirm shared workspace writes');
    const model={provider:text(request.model?.provider,'provider',256),model:text(request.model?.model,'model',256)};
    if(request.model?.reasoningEffort!==undefined) model.reasoningEffort=text(request.model.reasoningEffort,'reasoning effort',128);
    const selectedText=request.selectedText ?? '';
    if(typeof selectedText!=='string' || selectedText.length>64000) throw new Error('Invalid selected text');
    if(this.records.size+this.creating>=100) throw new Error('Saved chat limit reached; delete older chats');
    this.creating++;
    try {
      const parent=await this.adapter.parentContext(parentId);
      this.assertOpen();
      const inherited=request.inheritContext ?? mode==='agent';
      const context=inherited ? parent.text : '';
      if(typeof context!=='string' || context.length>LIMIT) throw new Error('Parent context exceeds Side Chat limit');
      const now=Date.now();
      const record={schema:1,id:randomUUID(),parentId,mode,permission:mode==='discuss'?'none':permission,model,context,cwd:parent.cwd,selectedText,title:(selectedText.trim() || (mode==='agent'?'Agent research':'Text discussion')).slice(0,60),messages:[],status:'idle',createdAt:now,updatedAt:now};
      await this.store.save(record);
      this.records.set(record.id,record);
      return clientRecord(record);
    } finally { this.creating--; }
  }
  async send(request) {
    this.assertOpen();
    const record=this.owned(request);
    const question=text(request.text,'message text').trim();
    if(this.deletions.has(record.id)) throw new Error('Chat deletion is in progress');
    if(this.jobs.has(record.id)) throw new Error('A reply is already running');
    if(record.messages.length>=128 || record.messages.reduce((n,m)=>n+m.text.length,question.length)>LIMIT) throw new Error('Discussion history limit reached');
    const prior=structuredClone(record);
    const reply={role:'assistant',text:'',status:'running'};
    record.messages.push({role:'user',text:question,status:'complete'},reply);
    record.status='running'; delete record.error; record.updatedAt=Date.now();
    const abort=new AbortController();
    let settle;
    const job={abort,done:new Promise(resolve=>{settle=resolve;})};
    this.jobs.set(record.id,job);
    try { await this.store.save(record); }
    catch(error) { record.messages.splice(-2); record.status='idle'; this.jobs.delete(record.id); settle(); throw error; }
    const signal=AbortSignal.any([abort.signal,AbortSignal.timeout(180000)]);
    void this.run(record,prior,reply,question,signal).finally(()=>{this.jobs.delete(record.id);settle();});
    // Run records all provider/persistence errors and fulfills: no detached rejection.
    return clientRecord(record);
  }
  async run(record,prior,reply,question,signal) {
    try {
      signal.throwIfAborted();
      const answer=await this.adapter.run(prior,question,{signal,onText:value=>{
        if(typeof value!=='string' || value.length>LIMIT) throw new Error('Side Chat reply exceeds output limit');
        reply.text=value;
      }});
      signal.throwIfAborted();
      if(typeof answer!=='string' || answer.length>LIMIT) throw new Error('Invalid Side Chat reply');
      reply.text=answer; reply.status='complete';
    } catch(error) {
      reply.status=signal.aborted?'stopped':'error';
      record.error=signal.aborted?'Reply stopped or timed out.':String(error?.message ?? error).slice(0,2000);
    } finally {
      record.status='idle'; record.updatedAt=Date.now();
      try { await this.store.save(record); }
      catch(error) { record.error=`Could not save reply: ${error.message}`; }
    }
  }
  async stop(request) {
    this.assertOpen(); const record=this.owned(request);
    const job=this.jobs.get(record.id);
    job?.abort.abort(new Error('Reply stopped'));
    await job?.done;
    return clientRecord(record);
  }
  async delete(request) {
    this.assertOpen();
    const record=this.owned(request);
    if(this.deletions.has(record.id)) return this.deletions.get(record.id);
    const operation=(async()=>{
      await this.stop(request);
      await this.adapter.close?.(record.id);
      await this.store.remove(record.id);
      this.records.delete(record.id);
      return {deleted:true};
    })().finally(()=>this.deletions.delete(record.id));
    this.deletions.set(record.id,operation);
    return operation;
  }
  async dispose() {
    this.closed=true;
    for(const job of this.jobs.values()) job.abort.abort(new Error('Plugin unloading'));
    await Promise.allSettled([...this.admissions, ...this.deletions.values()]);
    await Promise.all([...this.jobs.values()].map(job=>job.done));
    await this.store.writes;
    await this.adapter.dispose();
  }
}
