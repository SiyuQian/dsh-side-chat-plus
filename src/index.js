import {isAbsolute,join} from 'node:path';
import {SideChatService,JsonStore} from './service.js';
import {createHandler} from './http.js';

export const name='dsh-side-chat-plus';
export const inject=['webServer','profileContext','llm','sessions','sessionQuery','agents','tools','fs','systemPrompt','subprocess','workingDirectory','sandboxPolicy','approval'];

/** Mount only after the profile and model/Agent services are ready. */
export async function mountHost(ctx,makeAdapter) {
  const directory=ctx.profileContext?.dir;
  if(typeof directory!=='string' || !isAbsolute(directory)) throw new Error('Active profile directory is unavailable');
  const factory=makeAdapter ?? (await import('./dsh-adapter.js')).createDshAdapter;
  const adapter=await factory(ctx);
  let service;
  try { service=await SideChatService.open(new JsonStore(join(directory,'data','side-chat-plus')),adapter); }
  catch(error) { await adapter.dispose(); throw error; }
  try {
    const unregister=ctx.webServer.register({kind:'exact',path:'/side-chat-plus/rpc',handler:createHandler(service)});
    ctx.effect(()=>async()=>{unregister();await service.dispose();});
  } catch(error) { await service.dispose(); throw error; }
  return service;
}

export async function apply(ctx) { await mountHost(ctx); }
