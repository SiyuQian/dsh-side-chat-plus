import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {mountHost} from '../src/index.js';

test('host registers one route after successful startup and drains models on disposal',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'side-chat-host-'));
  const events=[]; let cleanup;
  const ctx={profileContext:{dir:directory},webServer:{register(route){events.push(route.path);return()=>events.push('unregister');}},effect(fn){cleanup=fn();}};
  await mountHost(ctx,async()=>({dispose:async()=>events.push('dispose')}));
  assert.deepEqual(events,['/side-chat-plus/rpc']);
  await cleanup();
  assert.deepEqual(events,['/side-chat-plus/rpc','unregister','dispose']);
});
test('host rejects missing active profile instead of storing relative to workspace',async()=>{
  await assert.rejects(mountHost({profileContext:{},effect(){}}),/profile/i);
});
