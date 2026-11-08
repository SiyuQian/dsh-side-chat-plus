import test from 'node:test';
import assert from 'node:assert/strict';

// The SDK boundary is injected: these tests never load a profile or call a model.
const load = async () => (await import('../src/dsh-adapter.js')).createDshAdapter;
const textBlock = text => ({ type: 'text', text });
const message = (role, text) => ({ role, content: [textBlock(text)] });
const record = overrides => ({ id: 'side-1', parentId: 'parent', mode: 'discuss', permission: 'none', model: { provider: 'p', model: 'm' }, context: 'parent snapshot', cwd: '/workspace', selectedText: 'selection', messages: [], ...overrides });

class Assembler {
  parts = new Map();
  finish = { kind: 'stop' };
  push(chunk) {
    if (chunk.type === 'text-delta') this.parts.set(chunk.index, { type: 'text', text: (this.parts.get(chunk.index)?.text ?? '') + chunk.text });
    if (chunk.type === 'block-end') this.parts.set(chunk.index, chunk.block);
    if (chunk.type === 'finish') this.finish = chunk.reason;
  }
  blocks() { return [...this.parts.values()]; }
  interruptedBlocks() { return this.blocks().filter(block => ['text', 'reasoning'].includes(block.type) && block.text.trim()); }
}

function harness({ chunks = [{ type: 'text-delta', index: 0, text: 'answer' }, { type: 'finish', reason: { kind: 'stop' } }], agentWork, disposeError, completedTurn = true } = {}) {
  const state = { calls: [], created: [], disposed: [], observedDisposed: 0, policies: [], guards: [], definitions: [], listeners: new Map() };
  let nextMessage = 0;
  const sdk = {
    BlockAssembler: Assembler,
    deriveEventMessage: event => event.type === 'user/message' ? event.data : event.data?.message ?? null,
    createUserMessage: input => ({ id: `user-${++nextMessage}`, role: 'user', ...input }),
    createAssistantMessage: input => ({ id: `assistant-${++nextMessage}`, role: 'assistant', ...input, source: { kind: 'model', ...input.source } }),
    setSandboxMode: (session, mode) => { session.mode = mode; state.policies.push(mode); },
    setApprovalPolicy: (session, policy) => { session.approval = policy; state.policies.push(policy); },
    FsConfig: config => config,
    SearchConfig: config => config,
    applyFs: (ctx, config) => {
      state.fsConfig = config;
      for (const name of ['read', ...(config.write ? ['write'] : []), ...(config.edit ? ['edit'] : [])]) ctx.tools.register({ name });
    },
    applySearch: async ctx => { ctx.tools.register({ name: 'glob' }); ctx.tools.register({ name: 'grep' }); },
    NativeToolExecutor: class { constructor(ctx) { this.ctx = ctx; } },
  };
  const ctx = {
    fs: { sandboxMode: 'read-only' }, systemPrompt: {}, subprocess: {}, approval: {}, sandboxPolicy: { resolve: ({ session }) => ({ mode: session.mode, workspaceRoot: session.header.cwd }) },
    workingDirectory: { set: async (agent, cwd) => { state.cwd = cwd; }, get: session => session.header.cwd },
    sessionQuery: { observeSession: async () => ({ header: { cwd: '/workspace' }, events: [], [Symbol.dispose]() { state.observedDisposed++; } }) },
    llm: {
      listProviders: () => [{ id: 'p', name: 'Provider' }],
      listModels: async () => [{ provider: 'p', id: 'm', name: 'Model' }],
      resolveCallConfig: async config => { state.validated = config; if (config.reasoningEffort === 'bad') throw new Error('Unsupported effort'); return config; },
      prepareCall: async config => ({ config, async *stream(options) { state.calls.push(options); for (const chunk of chunks) yield chunk; } }),
    },
    agents: {
      create: async options => {
        state.created.push(options);
        const local = [];
        let guard;
        const tools = {
          restrict: filter => { state.restriction = filter; },
          guard: fn => { guard = fn; state.guards.push(fn); },
          register: definition => local.push(definition),
          definitions: () => local,
          get: name => local.find(tool => tool.name === name),
          setExecutor: executor => { state.executor = executor; },
        };
        const agentCtx = { ...ctx, tools, on: (event, listener) => { state.listeners.set(event, listener); return () => state.listeners.delete(event); } };
        const session = { id: options.sessionId, header: { cwd: options.meta.cwd }, seq: 0, deriveMessages: () => [] };
        const agent = { id: options.sessionId, ctx: agentCtx, session, model: { select: model => { state.selected = model; } }, cancel: (...args) => { state.canceled = args; state.resolveIdle?.(); }, whenIdle: async () => { await state.idle; if (completedTurn) state.listeners.get('session/event')?.(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }); }, inject: msg => { state.injected = msg; }, followup: msg => {
          state.followup = msg;
          state.idle = agentWork ? agentWork({ state, agent, guard, local }) : Promise.resolve().then(() => {
            state.listeners.get('session/event')?.(session, { type: 'assistant/message', surfaceOp: 'append', data: { message: { role: 'assistant', content: [textBlock('agent answer'), { type: 'reasoning', text: 'secret' }] } } });
          });
        } };
        const commit = await options.setup(agentCtx, agent);
        commit?.commit();
        state.published = true;
        state.definitions = local;
        return { agent, dispose: async () => { state.disposed.push(agent.id); if (disposeError) throw disposeError; } };
      },
    },
  };
  return { state, ctx, sdk };
}

async function waitForPrompt(state) {
  for (let tick = 0; tick < 20 && !state.followup; tick++) await new Promise(resolve => setImmediate(resolve));
  assert.ok(state.followup, 'Agent must receive the prompt');
}

test('parent context is an append-only text snapshot without tools or reasoning and releases its lease', async () => {
  const { ctx, sdk, state } = harness();
  ctx.sessionQuery.observeSession = async (_id, options) => {
    assert.equal(options.projectionMode, 'none');
    return { header: { cwd: '/original' }, events: [
      { type: 'user/message', surfaceOp: 'append', data: message('user', 'question') },
      { type: 'assistant/message', surfaceOp: 'append', data: { message: { role: 'assistant', content: [textBlock('reply'), { type: 'reasoning', text: 'private' }, { type: 'tool-call', name: 'bash' }] } } },
      { type: 'tool/result', surfaceOp: 'append', data: { message: message('tool', 'tool secret') } },
      { type: 'user/message', surfaceOp: { op: 'replace', startSeq: 0, endSeq: 0 }, data: message('user', 'replacement') },
      { type: 'working-directory/change', data: { cwd: '/current' } },
    ], [Symbol.dispose]() { state.observedDisposed++; } };
  };
  const adapter = await (await load())(ctx, sdk);
  assert.deepEqual(await adapter.parentContext('parent'), { text: 'user: question\n\nassistant: reply', cwd: '/current' });
  assert.equal(state.observedDisposed, 1);
});

test('pure mode has no Agent, tools, reasoning persistence, or global model changes', async () => {
  const { ctx, sdk, state } = harness({ chunks: [{ type: 'reasoning-delta', index: 0, text: 'secret' }, { type: 'text-delta', index: 1, text: 'hel' }, { type: 'block-end', index: 1, block: textBlock('hello') }, { type: 'finish', reason: { kind: 'stop' } }] });
  const adapter = await (await load())(ctx, sdk);
  const updates = [];
  assert.equal(await adapter.run(record({ messages: [{ role: 'assistant', text: 'previous', status: 'done' }] }), 'ask', { onText: value => updates.push(value) }), 'hello');
  assert.deepEqual(updates, ['hel', 'hello']);
  assert.deepEqual(state.calls[0].tools, []);
  assert.match(state.calls[0].system, /reference/i);
  assert.match(JSON.stringify(state.calls[0].messages), /parent snapshot/);
  assert.match(JSON.stringify(state.calls[0].messages), /previous/);
  assert.equal(JSON.stringify(state.calls).includes('secret'), false);
  assert.equal(state.created.length, 0);
});

for (const chunk of [
  { type: 'tool-call-delta', index: 0, id: 't', name: 'read', argumentsDelta: '{}' },
  { type: 'block-start', index: 0, blockType: 'tool-call' },
  { type: 'block-end', index: 0, block: { type: 'tool-call', id: 't', name: 'read', arguments: '{}' } },
  { type: 'finish', reason: { kind: 'tool-calls' } },
  { type: 'finish', reason: { kind: 'error', failure: { message: 'provider failed', code: 'TEST' } } },
  { type: 'finish', reason: { kind: 'aborted', failure: { message: 'aborted', code: 'TEST' } } },
]) test(`pure mode rejects unsafe or failed stream ${chunk.type}/${chunk.reason?.kind ?? chunk.blockType ?? chunk.block?.type ?? ''}`, async () => {
  const { ctx, sdk } = harness({ chunks: [chunk] });
  const adapter = await (await load())(ctx, sdk);
  await assert.rejects(adapter.run(record(), 'ask', {}), /tool|provider failed|aborted/i);
});

test('models are flattened from configured routes and bad selections fail before calls', async () => {
  const { ctx, sdk, state } = harness();
  const adapter = await (await load())(ctx, sdk);
  assert.deepEqual(await adapter.models(), [{ provider: 'p', model: 'm', name: 'Model' }]);
  await assert.rejects(adapter.run(record({ model: { provider: 'p', model: 'm', reasoningEffort: 'bad' } }), 'ask', {}), /Unsupported/);
  await assert.rejects(adapter.run(record({ model: { provider: 'unknown', model: 'm' } }), 'ask', {}), /model|provider/i);
  assert.equal(state.calls.length, 0);
});

test('read-only Agent publishes only real scoped filesystem tools behind native execution and SAFE guard', async () => {
  const { ctx, sdk, state } = harness();
  const adapter = await (await load())(ctx, sdk);
  const updates = [];
  assert.equal(await adapter.run(record({ mode: 'agent', permission: 'read-only' }), 'ask', { onText: text => updates.push(text) }), 'agent answer');
  assert.deepEqual(state.restriction, { allow: [] });
  assert.deepEqual(state.definitions.map(tool => tool.name).sort(), ['glob', 'grep', 'read']);
  assert.equal(state.fsConfig.readImage, false);
  assert.equal(state.fsConfig.write, false);
  assert.equal(state.fsConfig.edit, false);
  assert.equal(state.fsConfig.applyPatch, false);
  assert.ok(state.executor instanceof sdk.NativeToolExecutor);
  assert.deepEqual(state.policies, ['read-only', 'never']);
  assert.equal(state.cwd, '/workspace');
  assert.equal(state.created[0].seed, undefined);
  assert.equal(state.created[0].meta.agentPreset, undefined);
  const guard = state.guards[0];
  assert.ok(guard({ name: 'bash', arguments: {} }));
  assert.ok(guard({ name: 'write', arguments: {} }));
  assert.ok(guard({ name: 'read', arguments: { sandbox_permissions: 'danger-full-access' } }));
  assert.deepEqual(updates, ['agent answer']);
});

test('workspace writes need explicit permission and a sandbox-enforcing filesystem', async () => {
  const { ctx, sdk, state } = harness();
  const adapter = await (await load())(ctx, sdk);
  await adapter.run(record({ mode: 'agent', permission: 'workspace-write' }), 'ask', {});
  assert.deepEqual(state.definitions.map(tool => tool.name).sort(), ['edit', 'glob', 'grep', 'read', 'write']);
  assert.equal(state.guards[0]({ name: 'write', arguments: {} }), undefined);
  assert.ok(state.guards[0]({ name: 'write', arguments: { sandbox_permissions: 'workspace-write' } }));
  assert.equal(state.policies[0], 'workspace-write');
  const unsafe = harness();
  delete unsafe.ctx.fs.sandboxMode;
  const denied = await (await load())(unsafe.ctx, unsafe.sdk);
  await assert.rejects(denied.run(record({ mode: 'agent', permission: 'workspace-write' }), 'ask', {}), /sandbox/i);
  assert.equal(unsafe.state.published, undefined);
});

test('Agent instances are keyed by discussion id and restores inject text rather than tool state', async () => {
  const { ctx, sdk, state } = harness();
  const adapter = await (await load())(ctx, sdk);
  const a = record({ mode: 'agent', permission: 'read-only', messages: [{ role: 'user', text: 'earlier', status: 'done' }] });
  await adapter.run(a, 'one', {});
  await adapter.run(a, 'two', {});
  await adapter.run({ ...a, id: 'side-2' }, 'three', {});
  assert.equal(state.created.length, 2);
  assert.match(JSON.stringify(state.injected), /earlier/);
  assert.match(JSON.stringify(state.injected), /parent snapshot/);
  await adapter.dispose();
  assert.equal(state.disposed.length, 2);
  await assert.rejects(adapter.run(a, 'late', {}), /disposed/i);
});

test('Agent cancellation calls cancel and waits for idle before rejecting', async () => {
  const { ctx, sdk, state } = harness({ agentWork: ({ state }) => new Promise(resolve => { state.resolveIdle = resolve; }) });
  const adapter = await (await load())(ctx, sdk);
  const controller = new AbortController();
  const pending = adapter.run(record({ mode: 'agent', permission: 'read-only' }), 'ask', { signal: controller.signal });
  await waitForPrompt(state);
  controller.abort();
  await assert.rejects(pending, /abort/i);
  assert.deepEqual(state.canceled, [{ kind: 'user' }, { keepInbox: false }]);
  await adapter.dispose();
});

test('dispose attempts every Agent and propagates teardown errors', async () => {
  const { ctx, sdk, state } = harness({ disposeError: new Error('teardown failed') });
  const adapter = await (await load())(ctx, sdk);
  await adapter.run(record({ mode: 'agent', permission: 'read-only' }), 'ask', {});
  await adapter.run(record({ id: 'other', mode: 'agent', permission: 'read-only' }), 'ask', {});
  await assert.rejects(adapter.dispose(), /teardown|dispose/i);
  assert.equal(state.disposed.length, 2);
});

test('terminal failures in committed Agent messages reject instead of saving a successful empty reply', async () => {
  const { ctx, sdk } = harness({ agentWork: ({ state, agent }) => Promise.resolve().then(() => {
    state.listeners.get('session/event')?.(agent.session, { type: 'assistant/message', surfaceOp: 'append', data: { message: message('assistant', 'partial'), stream: [{ type: 'chunk', time: 0, chunk: { type: 'finish', reason: { kind: 'error', failure: { message: 'Agent provider failed', code: 'TEST' } } } }] } });
    state.listeners.get('session/event')?.(agent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { message: 'Agent provider failed', code: 'TEST' } } } });
  }) });
  const adapter = await (await load())(ctx, sdk);
  await assert.rejects(adapter.run(record({ mode: 'agent', permission: 'read-only' }), 'ask', {}), /Agent provider failed/);
});

for (const reason of [{ kind: 'error', error: { message: 'pre-step failure', code: 'TEST' } }, { kind: 'blocked' }, { kind: 'aborted', reason: { kind: 'user' } }, { kind: 'max-tokens' }]) {
  test(`Agent turn termination ${reason.kind} rejects rather than returning success`, async () => {
    const { ctx, sdk } = harness({ agentWork: ({ state, agent }) => Promise.resolve().then(() => {
      state.listeners.get('session/event')?.(agent.session, { type: 'turn/end', data: { turn: 1, reason } });
    }) });
    const adapter = await (await load())(ctx, sdk);
    await assert.rejects(adapter.run(record({ mode: 'agent', permission: 'read-only' }), 'ask', {}), /pre-step failure|blocked|abort|max-tokens/i);
  });
}

test('SAFE guard rejects changed capability identity and changed session policy', async () => {
  const { ctx, sdk } = harness({ agentWork: ({ guard, agent, local }) => {
    assert.equal(guard({ name: 'read', arguments: {} }), undefined);
    agent.session.mode = 'danger-full-access';
    assert.ok(guard({ name: 'read', arguments: {} }));
    agent.session.mode = 'read-only';
    local.splice(0, 1, { name: 'read' });
    assert.ok(guard({ name: 'read', arguments: {} }));
    return Promise.resolve();
  } });
  const adapter = await (await load())(ctx, sdk);
  await adapter.run(record({ mode: 'agent', permission: 'read-only' }), 'ask', {});
});

test('setup fails closed before publication when extra tools appear', async () => {
  const { ctx, sdk, state } = harness();
  const applySearch = sdk.applySearch;
  sdk.applySearch = async agentCtx => { await applySearch(agentCtx); agentCtx.tools.register({ name: 'bash' }); };
  const adapter = await (await load())(ctx, sdk);
  await assert.rejects(adapter.run(record({ mode: 'agent', permission: 'read-only' }), 'ask', {}), /SAFE/);
  assert.equal(state.published, undefined);
});

test('dispose cancels active work and drains it before disposing owned Agents', async () => {
  const { ctx, sdk, state } = harness({ agentWork: ({ state }) => new Promise(resolve => { state.resolveIdle = resolve; }) });
  const adapter = await (await load())(ctx, sdk);
  const run = adapter.run(record({ mode: 'agent', permission: 'read-only' }), 'ask', {});
  const rejected = assert.rejects(run, /abort/i);
  await waitForPrompt(state);
  await adapter.dispose();
  await rejected;
  assert.equal(state.disposed.length, 1);
  assert.ok(state.canceled);
});

test('cancellation before a run creates no Agent or model stream', async () => {
  const { ctx, sdk, state } = harness();
  const adapter = await (await load())(ctx, sdk);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(adapter.run(record({ mode: 'agent', permission: 'read-only' }), 'ask', { signal: controller.signal }), /abort/i);
  assert.equal(state.created.length, 0);
  assert.equal(state.calls.length, 0);
});

for (const chunks of [[], [{ type: 'text-delta', index: 0, text: 'partial' }], [{ type: 'finish', reason: { kind: 'max-tokens' } }], [{ type: 'finish', reason: { kind: 'stop' } }, { type: 'text-delta', index: 0, text: 'late' }]]) {
  test(`pure mode rejects incomplete, truncated, or post-terminal streams ${JSON.stringify(chunks)}`, async () => {
    const { ctx, sdk } = harness({ chunks });
    const adapter = await (await load())(ctx, sdk);
    await assert.rejects(adapter.run(record(), 'ask', {}), /terminal|truncat|max-tokens|finish/i);
  });
}

test('catalog keeps working when an unrelated configured provider is offline', async () => {
  const { ctx, sdk } = harness();
  ctx.llm.listProviders = () => [{ id: 'offline' }, { id: 'p' }];
  ctx.llm.listModels = async provider => { if (provider === 'offline') throw new Error('offline'); return [{ provider: 'p', id: 'm', name: 'Model' }]; };
  const adapter = await (await load())(ctx, sdk);
  assert.deepEqual(await adapter.models(), [{ provider: 'p', model: 'm', name: 'Model' }]);
});

test('close releases a deleted discussion Agent and is idempotent', async () => {
  const { ctx, sdk, state } = harness();
  const adapter = await (await load())(ctx, sdk);
  await adapter.run(record({ mode: 'agent', permission: 'read-only' }), 'ask', {});
  assert.equal(typeof adapter.close, 'function');
  await adapter.close('side-1');
  await adapter.close('side-1');
  assert.equal(state.disposed.length, 1);
  await adapter.dispose();
  assert.equal(state.disposed.length, 1);
});

test('setup rejects an incorrect resolved sandbox policy before publication', async () => {
  const { ctx, sdk, state } = harness();
  ctx.sandboxPolicy.resolve = () => ({ mode: 'danger-full-access', workspaceRoot: '/other' });
  const adapter = await (await load())(ctx, sdk);
  await assert.rejects(adapter.run(record({ mode: 'agent', permission: 'workspace-write' }), 'ask', {}), /SAFE|policy/i);
  assert.equal(state.published, undefined);
});

test('workspace-write fails closed when deployment grants extra writable roots', async () => {
  const { ctx, sdk, state } = harness();
  ctx.sandboxPolicy.resolve = ({ session }) => ({ mode: session.mode, workspaceRoot: session.header.cwd, additionalWritableRoots: ['/outside'] });
  const adapter = await (await load())(ctx, sdk);
  await assert.rejects(adapter.run(record({ mode: 'agent', permission: 'workspace-write' }), 'ask', {}), /SAFE|policy|roots/i);
  assert.equal(state.published, undefined);
});

test('SAFE guard rejects extra writable roots introduced after publication', async () => {
  const { ctx, sdk } = harness({ agentWork: ({ guard }) => {
    assert.equal(guard({ name: 'write', arguments: {} }), undefined);
    ctx.sandboxPolicy.resolve = () => ({ mode: 'workspace-write', workspaceRoot: '/workspace', additionalWritableRoots: ['/outside'] });
    assert.ok(guard({ name: 'write', arguments: {} }));
    return Promise.resolve();
  } });
  const adapter = await (await load())(ctx, sdk);
  await adapter.run(record({ mode: 'agent', permission: 'workspace-write' }), 'ask', {});
});

test('recoverable failed Agent attempts do not cancel the retry or successful turn', async () => {
  const { ctx, sdk, state } = harness({ agentWork: ({ state, agent }) => Promise.resolve().then(() => {
    const emit = event => state.listeners.get('session/event')?.(agent.session, event);
    emit({ type: 'assistant/attempt', data: { turn: 1, step: 1, stream: [{ type: 'chunk', time: 0, chunk: { type: 'finish', reason: { kind: 'error', failure: { message: 'retryable failure', code: 'TEST' } } } }] } });
    assert.equal(state.canceled, undefined);
    emit({ type: 'assistant/message', surfaceOp: 'append', data: { message: message('assistant', 'retried answer') } });
    emit({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  }) });
  const adapter = await (await load())(ctx, sdk);
  assert.equal(await adapter.run(record({ mode: 'agent', permission: 'read-only' }), 'ask', {}), 'retried answer');
  assert.equal(state.canceled, undefined);
});

test('Agent idle without a committed completed turn is not reported as success', async () => {
  const { ctx, sdk } = harness({ completedTurn: false });
  const adapter = await (await load())(ctx, sdk);
  await assert.rejects(adapter.run(record({ mode: 'agent', permission: 'read-only' }), 'ask', {}), /completed|terminal|turn/i);
});

test('changed permissions replace the owned Agent rather than retaining old tools', async () => {
  const { ctx, sdk, state } = harness();
  const adapter = await (await load())(ctx, sdk);
  await adapter.run(record({ mode: 'agent', permission: 'workspace-write' }), 'ask', {});
  await adapter.run(record({ mode: 'agent', permission: 'read-only' }), 'ask', {});
  assert.equal(state.created.length, 2);
  assert.equal(state.disposed.length, 1);
  assert.deepEqual(state.definitions.map(tool => tool.name).sort(), ['glob', 'grep', 'read']);
});
