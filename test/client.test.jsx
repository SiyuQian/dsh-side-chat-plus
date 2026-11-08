import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body><main><p id="transcript">主会话选中文字</p></main><div id="root"></div></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import('react-dom/client');

const client = await import('../src/client.jsx');

test('registers a retained native sidebar tab and only public keyed/header slots', () => {
  const registered = [];
  const definitions = [];
  let dependencies;
  let dispose;
  const ctx = {
    inject(names, callback) { dependencies = names; dispose = callback(this); },
    effect(callback) { return callback(); },
    get(name) { return this[name]; },
    sidebarRightTabs: { register(value) { definitions.push(value); return () => {}; } },
    sidebarRight: {}, sessions: {}, conversation: {},
    slots: {
      inject(_name, callback) { callback(); return () => {}; },
      register(options, component) { registered.push({ options, component }); return () => {}; },
    },
  };
  client.apply(ctx);
  assert.equal(definitions.length, 1, 'must register the native tab implementation');
  assert.equal(definitions[0].keepMounted, true, 'hiding a tab must not end its run');
  assert.deepEqual(dependencies, ['sidebarRightTabs', 'sidebarRight', 'slots', 'sessions', 'conversation']);
  assert.deepEqual(registered.map(entry => entry.options.name), ['sidebar.right.pane.tab', 'conversation.session.header.utilities']);
  assert.equal(registered[0].options.key, definitions[0].id);
  assert.equal(registered[0].options.inject('parent-a').sessionId, 'parent-a');
  assert.match(document.head.querySelector('style[data-side-chat-plus]')?.textContent || '', /--dsw-alias-bg-base/, 'native tokens must actually reach the DOM');
  dispose();
  assert.equal(document.head.querySelector('style[data-side-chat-plus]'), null);
});

function saved(overrides = {}) {
  return { id: 'chat-1', parentId: 'parent-a', title: '已经保存的讨论', mode: 'discuss', permission: 'read-only', model: { provider: 'p', model: 'm' }, selectedText: '', messages: [], status: 'idle', createdAt: 1, updatedAt: 1, ...overrides };
}

async function mountPanel(t, { records = [], handler, parentId = 'parent-a', tab } = {}) {
  const calls = [];
  const rpc = async (action, payload) => {
    calls.push({ action, ...payload });
    if (handler) { const value = await handler(action, payload); if (value !== undefined) return value; }
    if (action === 'models') return [{ provider: 'p', model: 'm', name: '独立模型' }];
    if (action === 'list') return records;
    if (action === 'get') return records.find(record => record.id === payload.id);
    if (action === 'create') return saved({ ...payload, id: 'created' });
    if (action === 'send') return saved({ id: payload.id, status: 'running', messages: [{ role: 'user', text: payload.text, status: 'complete' }] });
    if (action === 'stop') return saved({ id: payload.id });
    if (action === 'delete') return { deleted: true };
    throw new Error(`unexpected action ${action}`);
  };
  const root = createRoot(document.getElementById('root'));
  const props = { ctx: {}, parentId, tab: tab ?? { signal: new AbortController().signal, navigation: {} }, rpc };
  await act(async () => root.render(<client.SideChatPanel {...props} />));
  let unmounted = false;
  const unmount = async () => { if (!unmounted) { unmounted = true; await act(async () => root.unmount()); } };
  t.after(unmount);
  return { calls, props, unmount, rerender: async (next) => act(async () => root.render(<client.SideChatPanel {...props} {...next} />)) };
}

async function key(node, options) {
  await act(async () => node.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...options })));
}
const field = label => document.querySelector(`[aria-label="${label}"]`);
const button = text => [...document.querySelectorAll('button')].find(node => node.textContent === text);
async function click(node) { assert.ok(node, 'button exists'); await act(async () => node.click()); }
async function change(node, value) {
  assert.ok(node, 'field exists');
  await act(async () => {
    const prototype = node.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLSelectElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(node, value);
    node.dispatchEvent(new window.Event('input', { bubbles: true }));
    node.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
}

test('opening loads saved chats without creating or running any model', async t => {
  const { calls } = await mountPanel(t, { records: [saved()] });
  assert.deepEqual(calls.map(call => call.action).sort(), ['list', 'models']);
  assert.match(field('恢复侧聊').textContent, /已经保存的讨论/);
  assert.equal(field('继承主会话上下文').checked, false);
  assert.equal(button('发送').disabled, true);
});

test('new Agent defaults to inherited context and requires confirmation for workspace writes', async t => {
  const { calls } = await mountPanel(t);
  await click(button('Agent'));
  assert.equal(field('继承主会话上下文').checked, true);
  await change(field('Agent 权限'), 'workspace-write');
  assert.match(document.body.textContent, /共享.*工作区/);
  await change(field('侧聊消息'), '请检查文件');
  assert.equal(button('发送').disabled, true);
  await click(field('确认工作区写入风险'));
  await click(button('发送'));
  const created = calls.find(call => call.action === 'create');
  assert.equal(created.mode, 'agent');
  assert.equal(created.permission, 'workspace-write');
  assert.equal(created.confirmWrite, true, 'service requires explicit write confirmation');
  assert.equal(created.inheritContext, true);
  assert.deepEqual(created.model, { provider: 'p', model: 'm' });
  assert.equal(calls.filter(call => call.action === 'send').length, 1);
  assert.equal(button('轻量讨论').disabled, true, 'mode is immutable after creation');
});

test('resume uses bound parent, keeps the draft on send errors and renders text safely', async t => {
  const { calls, rerender } = await mountPanel(t, {
    records: [saved({ messages: [{ role: 'assistant', text: '<img src=x onerror=alert(1)>', status: 'complete' }] })],
    handler(action) { if (action === 'send') throw new Error('模型不可用'); },
  });
  await change(field('恢复侧聊'), 'chat-1');
  assert.match(document.body.textContent, /<img src=x onerror=alert\(1\)>/);
  assert.equal(document.querySelector('.sc-plus img'), null);
  await rerender({ ctx: { sessions: { list: { getSnapshot: () => ({ current: 'parent-b' }) } } } });
  await change(field('侧聊消息'), '保留这条消息');
  await click(button('发送'));
  assert.equal(calls.find(call => call.action === 'send').parentId, 'parent-a');
  assert.equal(field('侧聊消息').value, '保留这条消息');
  assert.match(document.querySelector('[role="alert"]').textContent, /模型不可用/);
});

test('hiding a tab does not stop a run, closing its signal does', async t => {
  const controller = new AbortController();
  const { calls, rerender } = await mountPanel(t, { records: [saved({ status: 'running' })], tab: { signal: controller.signal, navigation: {} } });
  await change(field('恢复侧聊'), 'chat-1');
  await rerender({ tab: { signal: controller.signal, visible: false, navigation: {} } });
  assert.equal(calls.some(call => call.action === 'stop'), false);
  await act(async () => controller.abort());
  assert.deepEqual(calls.filter(call => call.action === 'stop'), [{ action: 'stop', id: 'chat-1', parentId: 'parent-a' }]);
});

test('a delayed poll cannot revive a run after the stop response', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let finishPoll;
  let gets = 0;
  await mountPanel(t, { records: [saved({ status: 'running' })], handler(action) {
    if (action === 'get' && ++gets > 1) return new Promise(resolve => { finishPoll = resolve; });
  } });
  await change(field('恢复侧聊'), 'chat-1');
  await act(async () => t.mock.timers.tick(500));
  await click(button('停止'));
  assert.equal(button('停止'), undefined);
  await act(async () => finishPoll(saved({ status: 'running' })));
  assert.equal(button('停止'), undefined, 'stale poll must not restore running state');
});

test('an unmounted body still stops its run when the native tab later closes', async t => {
  const controller = new AbortController();
  const { calls, unmount } = await mountPanel(t, { records: [saved({ status: 'running' })], tab: { signal: controller.signal, navigation: {} } });
  await change(field('恢复侧聊'), 'chat-1');
  await unmount();
  controller.abort();
  await Promise.resolve();
  assert.equal(calls.filter(call => call.action === 'stop').length, 1);
});

test('double clicking send in a single commit cannot create duplicate chats', async t => {
  const { calls } = await mountPanel(t);
  await change(field('侧聊消息'), '只发送一次');
  const send = button('发送');
  await act(async () => { send.click(); send.click(); });
  assert.equal(calls.filter(call => call.action === 'create').length, 1);
  assert.equal(calls.filter(call => call.action === 'send').length, 1);
});

test('closing during an outstanding send also stops the run after its acknowledgement', async t => {
  const controller = new AbortController();
  let acknowledge;
  const { calls } = await mountPanel(t, { tab: { signal: controller.signal, navigation: {} }, handler(action) {
    if (action === 'send') return new Promise(resolve => { acknowledge = resolve; });
  } });
  await change(field('侧聊消息'), '运行这条');
  await click(button('发送'));
  await act(async () => controller.abort());
  assert.equal(calls.filter(call => call.action === 'stop').length, 1);
  await act(async () => acknowledge(saved({ id: 'created', status: 'running' })));
  assert.equal(calls.filter(call => call.action === 'stop').length, 2, 'acknowledgement race cannot leave a run active');
});

test('Enter sends, Shift Enter and IME composition never send', async t => {
  const { calls } = await mountPanel(t);
  await change(field('侧聊消息'), '一条新消息');
  await key(field('侧聊消息'), { shiftKey: true });
  await key(field('侧聊消息'), { isComposing: true });
  assert.equal(calls.some(call => call.action === 'create'), false);
  await key(field('侧聊消息'), {});
  assert.equal(calls.filter(call => call.action === 'send').length, 1);
});

test('reset keeps an unsent composer draft and leaves saved chats recoverable', async t => {
  await mountPanel(t, { records: [saved()] });
  await change(field('恢复侧聊'), 'chat-1');
  await change(field('侧聊消息'), '尚未发送');
  await click(button('新建'));
  assert.equal(field('侧聊消息').value, '尚未发送');
  assert.match(field('恢复侧聊').textContent, /已经保存的讨论/);
  assert.equal(button('Agent').disabled, false);
});

test('resume cannot discard an unsent draft without explicit confirmation', async t => {
  const confirm = window.confirm;
  window.confirm = () => false;
  t.after(() => { window.confirm = confirm; });
  const { calls } = await mountPanel(t, { records: [saved()] });
  await change(field('侧聊消息'), '不能丢失');
  await change(field('恢复侧聊'), 'chat-1');
  assert.equal(calls.some(call => call.action === 'get'), false);
  assert.equal(field('侧聊消息').value, '不能丢失');
});

test('reset cannot discard an edited conclusion without explicit confirmation', async t => {
  const confirm = window.confirm;
  window.confirm = () => false;
  t.after(() => { window.confirm = confirm; });
  await mountPanel(t, { records: [saved()] });
  await change(field('恢复侧聊'), 'chat-1');
  await change(field('可编辑结论'), '还没带回去');
  await click(button('新建'));
  assert.equal(field('恢复侧聊').value, 'chat-1');
  assert.equal(field('可编辑结论').value, '还没带回去');
});

test('copy failure selects the editable conclusion for manual copying', async t => {
  await mountPanel(t);
  await change(field('可编辑结论'), '可手动复制');
  await click(button('复制结论'));
  assert.equal(field('可编辑结论').selectionStart, 0);
  assert.equal(field('可编辑结论').selectionEnd, 5);
  assert.match(document.querySelector('[role="status"]').textContent, /Ctrl\/Cmd \+ C/);
});

test('opening tolerates model/list transport failures with visible feedback', async t => {
  await mountPanel(t, { records: [saved()], handler(action) { if (action === 'models') throw new Error('目录加载失败'); } });
  assert.match(document.querySelector('[role="alert"]').textContent, /目录加载失败/);
  assert.match(field('恢复侧聊').textContent, /已经保存的讨论/, 'catalog failure must not hide saved chats');
});

test('RPC posts JSON and surfaces HTTP and application errors', async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (url, options) => {
    assert.equal(url, '/side-chat-plus/rpc');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(options.body), { action: 'get', id: 'chat-1', parentId: 'parent-a' });
    return { ok: true, json: async () => ({ ok: true, value: saved() }) };
  };
  assert.equal((await client.rpc('get', { id: 'chat-1', parentId: 'parent-a' })).id, 'chat-1');
  globalThis.fetch = async () => ({ ok: false, status: 400, json: async () => ({ ok: false, error: '需要确认工作区写入' }) });
  await assert.rejects(() => client.rpc('create'), /需要确认工作区写入/);
  globalThis.fetch = async () => ({ ok: false, status: 503 });
  await assert.rejects(() => client.rpc('list'), /503/);
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: false, error: '拒绝访问' }) });
  await assert.rejects(() => client.rpc('list'), /拒绝访问/);
});

test('append conclusion resolves only the bound parent and never submits or overwrites draft', () => {
  let draft = '原来的草稿';
  const scope = { sessionId: 'parent-a' };
  const input = { state: { getSnapshot: () => ({ draft, phase: 'plain', queue: [], occurrences: [] }) }, setDraft(text) { draft = text; }, submit() { assert.fail('must never submit'); } };
  const ctx = { sessions: { scope(id) { assert.equal(id, 'parent-a'); return scope; } }, conversation: { input: { for(value) { assert.equal(value, scope); return input; } } } };
  assert.equal(client.appendConclusion(ctx, 'parent-a', '最终结论'), true);
  assert.equal(draft, '原来的草稿\n\n最终结论');
});

test('conclusion insertion rejects missing, busy, queued and structured replacement owners', () => {
  for (const state of [{ draft: '', phase: 'claimed' }, { draft: '', phase: 'plain', queue: [{}] }, { draft: '@ref', phase: 'plain', occurrences: [{}] }]) {
    const ctx = { sessions: { scope: () => ({}) }, conversation: { input: { for: () => ({ state: { getSnapshot: () => state }, setDraft() { assert.fail('unsafe mutation'); } }) } } };
    assert.throws(() => client.appendConclusion(ctx, 'parent-a', '结论'));
  }
  assert.throws(() => client.appendConclusion({ sessions: { scope: () => undefined } }, 'parent-a', '结论'));
});

test('newest SDK appends through revision guarded scoped event without replacing references', () => {
  let draft = '@reference 原草稿';
  const state = () => ({ draft, draftRev: 12, phase: 'plain', queue: [], occurrences: [{ offset: 0 }] });
  const scope = { bail(name, request) {
    assert.equal(name, 'slash/input-insert-text');
    assert.deepEqual(request, { text: '\n\n结论', span: { start: 14, end: 14, draftRev: 12 } });
    draft += request.text; return true;
  } };
  const ctx = { sessions: { scope: () => scope }, conversation: { input: { for: () => ({ state: { getSnapshot: state }, setDraft() { assert.fail('must preserve references'); } }) } } };
  assert.equal(client.appendConclusion(ctx, 'parent-a', '结论'), true);
  assert.equal(draft, '@reference 原草稿\n\n结论');
});

test('captures selected transcript text but ignores panel and composer selections', () => {
  const transcript = document.getElementById('transcript');
  const range = document.createRange(); range.selectNodeContents(transcript);
  const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
  assert.equal(client.selectedTranscriptText({ target: transcript }, selection), '主会话选中文字');
  const panel = document.createElement('div'); panel.className = 'sc-plus';
  const input = document.createElement('textarea'); panel.append(input); document.body.append(panel);
  assert.equal(client.selectedTranscriptText({ target: input }, selection), '');
  panel.remove(); selection.removeAllRanges();
});
