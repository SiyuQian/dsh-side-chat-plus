import React, { Component, useEffect, useRef, useState } from 'react';
import css from './client.css';

const TAB_ID = 'dsh-side-chat-plus:panel';
const TAB_KIND = 'side-chat-plus';

/** Register through service injection: slots can exist before the native registry. */
export function apply(ctx) {
  return ctx.inject(['sidebarRightTabs', 'sidebarRight', 'slots', 'sessions', 'conversation'], (services) => {
    const disposers = [];
    disposers.push(services.effect(() => {
      const style = document.createElement('style');
      style.dataset.sideChatPlus = '';
      style.textContent = css;
      document.head.append(style);
      return () => style.remove();
    }));
    disposers.push(services.sidebarRightTabs.register({
      id: TAB_ID, kind: TAB_KIND, multiple: true, keepMounted: true,
      priority: 'extension', title: () => 'Side Chat',
      guide: [{ order: 65, title: () => 'Side Chat', description: () => '独立讨论，或交给只读 Agent' }],
    }));
    disposers.push(services.slots.inject('sidebar.right.pane.tab', () => services.slots.register({
      name: 'sidebar.right.pane.tab', key: TAB_ID,
      inject: (sessionId) => ({ ctx: services, sessionId }),
    }, NativePanel)));
    disposers.push(services.slots.inject('conversation.session.header.utilities', () => services.slots.register({
      name: 'conversation.session.header.utilities', order: 65,
      inject: (sessionId) => ({ ctx: services, sessionId }),
    }, HeaderButton)));
    return () => disposers.reverse().forEach(dispose => dispose?.());
  });
}

function NativePanel(props) {
  return <PanelBoundary><NativePanelBody {...props} /></PanelBoundary>;
}

function NativePanelBody({ ctx, sessionId, useTabInfo }) {
  const { tab } = useTabInfo();
  return <SideChatPanel key={`${sessionId}:${tab.id}`} ctx={ctx} parentId={sessionId} tab={tab} />;
}

class PanelBoundary extends Component {
  state = { error: '' };
  static getDerivedStateFromError(error) { return { error: error.message || String(error) }; }
  render() { return this.state.error ? <div className="sc-plus sc-plus-error" role="alert">侧聊暂时不可用：{this.state.error}</div> : this.props.children; }
}

const selections = new Map();
const ignoredSelection = '.sc-plus, .sc-plus-launch, input, textarea, select, [contenteditable]:not([contenteditable="false"])';
const elementOf = node => node?.nodeType === 1 ? node : node?.parentElement;

/** Only transcript selections are admitted; side panels and input drafts are private. */
export function selectedTranscriptText(event, selection = window.getSelection()) {
  const target = elementOf(event.target);
  if (!selection || selection.isCollapsed || target?.closest(ignoredSelection)) return '';
  const anchor = elementOf(selection.anchorNode);
  const focus = elementOf(selection.focusNode);
  const main = anchor?.closest('main, [role="main"]');
  if (!main || !focus || !main.contains(focus) || anchor.closest(ignoredSelection) || focus.closest(ignoredSelection)) return '';
  return selection.toString().trim().slice(0, 24000);
}

function useSelectionCapture(ctx, parentId, accept) {
  const acceptRef = useRef(accept);
  acceptRef.current = accept;
  useEffect(() => {
    const capture = event => {
      const mounted = ctx.sidebarRight?.mounted?.getSnapshot?.();
      if (mounted !== undefined && mounted !== parentId) return;
      const text = selectedTranscriptText(event);
      if (text) { selections.set(parentId, text); acceptRef.current?.(text); }
    };
    document.addEventListener('pointerup', capture);
    return () => document.removeEventListener('pointerup', capture);
  }, [ctx, parentId]);
}

function HeaderButton({ ctx, sessionId }) {
  const [error, setError] = useState('');
  useSelectionCapture(ctx, sessionId);
  const open = () => {
    try {
      ctx.sidebarRight.openTab(TAB_KIND, { params: { parentId: sessionId, selectedText: selections.get(sessionId) || '' } });
      setError('');
    } catch (error) { setError(error.message || String(error)); }
  };
  return <span className="sc-plus-launch"><button type="button" title="打开独立侧聊" onClick={open}>Side Chat</button>{error && <span role="alert">{error}</span>}</span>;
}

/** JSON RPC never runs a model by itself; only the explicit send action does. */
export async function rpc(action, payload = {}) {
  const response = await fetch('/side-chat-plus/rpc', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...payload }),
  });
  let result;
  try { result = await response.json(); }
  catch { throw new Error(response.ok ? '侧聊服务返回了无效 JSON' : `侧聊请求失败（HTTP ${response.status}）`); }
  if (result?.ok === false && typeof result.error === 'string') throw new Error(result.error);
  if (!response.ok) throw new Error(`侧聊请求失败（HTTP ${response.status}）`);
  if (result?.ok !== true) throw new Error('侧聊服务返回了无效结果');
  return result.value;
}

/** Append synchronously to a captured Session, refusing busy or queued owners. */
export function appendConclusion(ctx, parentId, text) {
  if (!text.trim()) throw new Error('请先填写结论');
  const scope = ctx.sessions.scope(parentId);
  if (!scope) throw new Error('主会话已不可用，请复制结论');
  const conversation = ctx.conversation ?? ctx.get?.('conversation');
  const input = conversation?.input?.for(scope);
  const state = input?.state?.getSnapshot();
  if (!state || typeof state.draft !== 'string' || state.phase !== 'plain' || (state.queue?.length ?? 0) > 0) {
    throw new Error('主会话输入框正在处理其他操作，请稍后重试或复制结论');
  }
  const suffix = `${state.draft ? '\n\n' : ''}${text}`;
  if (typeof input.insertText === 'function' && typeof state.draftRev === 'number') {
    if (!input.insertText(suffix, { start: state.draft.length, end: state.draft.length, draftRev: state.draftRev })) throw new Error('草稿已变化，请重试');
  } else if (typeof scope.bail === 'function' && typeof state.draftRev === 'number') {
    const applied = scope.bail('slash/input-insert-text', { text: suffix, span: { start: state.draft.length, end: state.draft.length, draftRev: state.draftRev } });
    if (applied !== true) throw new Error('输入框尚未就绪，请复制结论');
  } else {
    if (state.occurrences?.length || typeof input.setDraft !== 'function') throw new Error('当前草稿含引用，无法安全追加，请复制结论');
    input.setDraft(state.draft + suffix);
  }
  if (input.state.getSnapshot().draft !== state.draft + suffix) throw new Error('未能追加到主会话，请复制结论');
  return true;
}

const modelKey = model => JSON.stringify([model.provider, model.model]);
const errorText = error => error?.message || String(error);

export function SideChatPanel({ ctx, parentId: ownerId, tab, rpc: request = rpc }) {
  const [parentId] = useState(ownerId);
  const [records, setRecords] = useState([]);
  const [models, setModels] = useState([]);
  const [model, setModel] = useState('');
  const [record, setRecord] = useState(null);
  const [mode, setMode] = useState('discuss');
  const [inheritContext, setInheritContext] = useState(false);
  const [permission, setPermission] = useState('read-only');
  const [confirmedWrite, setConfirmedWrite] = useState(false);
  const [selectedText, setSelectedText] = useState(() => tab.navigation?.params?.selectedText || selections.get(parentId) || '');
  const [draft, setDraft] = useState('');
  const [conclusion, setConclusion] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [closed, setClosed] = useState(tab.signal.aborted);
  const live = useRef({ mounted: false, closed: tab.signal.aborted, record: null, sending: false });
  const operation = useRef(0);
  const actionPending = useRef(false);
  const conclusionRef = useRef(null);
  const running = record?.status === 'running';
  const locked = busy || running || closed;

  const acceptRecord = value => {
    if (!value || value.parentId !== parentId) throw new Error('侧聊与主会话不匹配');
    live.current.record = value;
    if (!live.current.mounted || live.current.closed) return;
    setRecord(value);
    setRecords(rows => [value, ...rows.filter(row => row.id !== value.id)]);
  };
  const stopClosedRun = async value => {
    if (value?.id && (value.status === 'running' || live.current.sending)) {
      try { await request('stop', { id: value.id, parentId }); }
      catch (error) { if (live.current.mounted) setError(`停止失败：${errorText(error)}`); else console.warn('[side-chat-plus] 停止失败', error); }
    }
  };

  useEffect(() => {
    live.current.mounted = true;
    const onClose = () => {
      live.current.closed = true;
      if (live.current.mounted) setClosed(true);
      void stopClosedRun(live.current.record);
    };
    tab.signal.addEventListener('abort', onClose, { once: true });
    let cancelled = false;
    const load = async () => {
      try {
        const [catalog, saved] = await Promise.allSettled([request('models'), request('list', { parentId })]);
        if (cancelled || live.current.closed) return;
        if (catalog.status === 'fulfilled') {
          setModels(catalog.value);
          setModel(catalog.value[0] ? modelKey(catalog.value[0]) : '');
        }
        if (saved.status === 'fulfilled') setRecords(saved.value.filter(row => row.parentId === parentId));
        const failures = [catalog, saved].filter(result => result.status === 'rejected');
        if (failures.length) setError(failures.map(result => errorText(result.reason)).join('；'));
      } catch (error) { if (!cancelled) setError(errorText(error)); }
      finally { if (!cancelled) setLoading(false); }
    };
    if (!tab.signal.aborted) void load();
    // React can unmount a hidden Session before its native tab is closed. Keep
    // the one-shot signal listener until the record lifetime actually ends.
    return () => { cancelled = true; live.current.mounted = false; };
  }, [parentId, tab.signal, request]);

  useSelectionCapture(ctx, parentId, text => { if (!record && !locked && tab.visible !== false) setSelectedText(text); });

  useEffect(() => {
    if (!running || closed) return;
    let cancelled = false;
    let timer;
    const poll = async () => {
      try {
        const value = await request('get', { id: record.id, parentId });
        if (!cancelled && !live.current.closed) acceptRecord(value);
      } catch (error) { if (!cancelled) setError(errorText(error)); }
      if (!cancelled) timer = setTimeout(poll, 900);
    };
    timer = setTimeout(poll, 500);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [record?.id, running, closed, parentId, request]);

  const runAction = async action => {
    if (live.current.closed || actionPending.current) return;
    actionPending.current = true;
    setBusy(true); setError(''); setNotice('');
    try { await action(); }
    catch (error) { if (live.current.mounted && !live.current.closed) setError(errorText(error)); }
    finally { actionPending.current = false; if (live.current.mounted) setBusy(false); }
  };

  const changeMode = next => {
    if (record || locked) return;
    setMode(next); setInheritContext(next === 'agent'); setPermission('read-only'); setConfirmedWrite(false);
  };
  const resume = id => runAction(async () => {
    if ((draft.trim() || conclusion.trim()) && !window.confirm('切换侧聊会清除当前未发送的消息和结论，是否继续？')) return;
    const token = ++operation.current;
    const value = await request('get', { id, parentId });
    if (token !== operation.current || live.current.closed) return;
    acceptRecord(value); setConclusion(''); setDraft('');
  });
  const reset = () => {
    if (locked) return;
    if (conclusion.trim() && !window.confirm('新建侧聊会清除尚未带回主会话的结论，是否继续？')) return;
    operation.current++;
    live.current.record = null; setRecord(null); setConclusion(''); setError(''); setNotice('');
    setMode('discuss'); setInheritContext(false); setPermission('read-only'); setConfirmedWrite(false);
  };
  const send = () => runAction(async () => {
    const text = draft.trim();
    if (!text || running || loading || (!record && !model)) return;
    if (!record && mode === 'agent' && permission === 'workspace-write' && !confirmedWrite) throw new Error('请先确认共享工作区写入风险');
    let current = record;
    if (!current) {
      const chosen = models.find(item => modelKey(item) === model);
      if (!chosen) throw new Error('请选择可用模型');
      current = await request('create', {
        parentId, mode, permission: mode === 'agent' ? permission : 'read-only', selectedText, inheritContext,
        confirmWrite: mode === 'agent' && permission === 'workspace-write' && confirmedWrite,
        model: { provider: chosen.provider, model: chosen.model },
      });
      acceptRecord(current);
    }
    if (live.current.closed) return;
    live.current.sending = true;
    try {
      const value = await request('send', { id: current.id, parentId, text });
      if (live.current.closed) { await stopClosedRun(value); return; }
      acceptRecord(value); setDraft('');
    } finally { live.current.sending = false; }
  });
  const stop = () => runAction(async () => acceptRecord(await request('stop', { id: record.id, parentId })));
  const remove = () => runAction(async () => {
    if (!window.confirm('删除这条已保存的侧聊？此操作无法撤销。')) return;
    await request('delete', { id: record.id, parentId });
    setRecords(rows => rows.filter(row => row.id !== record.id));
    live.current.record = null; setRecord(null); setConclusion(''); setNotice('侧聊已删除');
  });
  const insert = () => runAction(async () => {
    appendConclusion(ctx, parentId, conclusion); setNotice('已追加到绑定主会话的草稿，尚未发送');
  });
  const copy = () => runAction(async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(conclusion); setNotice('已复制结论');
    } catch {
      conclusionRef.current?.focus(); conclusionRef.current?.select();
      setNotice('请按 Ctrl/Cmd + C 复制已选中的结论');
    }
  });
  const displayedMode = record?.mode || mode;
  const quote = record?.selectedText ?? selectedText;
  const lastAnswer = [...(record?.messages || [])].reverse().find(message => message.role === 'assistant' && message.text)?.text;
  const sendDisabled = locked || loading || !draft.trim() || (!record && (!model || (mode === 'agent' && permission === 'workspace-write' && !confirmedWrite)));

  return <section className="sc-plus" aria-label="独立侧聊">
    <header className="sc-plus-heading"><span className="sc-plus-mark" aria-hidden="true">↗</span><div><h2>Side Chat <span>PLUS</span></h2><p>把岔路聊清楚，再带回主线</p></div><span className={`sc-plus-status ${running ? 'is-running' : ''}`}>{closed ? '已关闭' : running ? '运行中' : '独立会话'}</span></header>
    <div className="sc-plus-toolbar"><select aria-label="恢复侧聊" value={record?.id || ''} disabled={locked || loading} onChange={event => event.target.value ? resume(event.target.value) : reset()}><option value="">新建侧聊 · 恢复历史…</option>{records.map(row => <option key={row.id} value={row.id}>{row.mode === 'agent' ? 'Agent' : '讨论'} · {row.title || '未命名侧聊'}</option>)}</select><button type="button" disabled={locked} onClick={reset}>新建</button>{record && <button type="button" disabled={locked} onClick={remove} title="删除当前侧聊">删除</button>}</div>
    <div className="sc-plus-modes" role="tablist" aria-label="侧聊模式"><button type="button" role="tab" aria-selected={displayedMode === 'discuss'} disabled={Boolean(record) || locked} onClick={() => changeMode('discuss')}>轻量讨论</button><button type="button" role="tab" aria-selected={displayedMode === 'agent'} disabled={Boolean(record) || locked} onClick={() => changeMode('agent')}>Agent</button></div>
    <div className="sc-plus-config"><p className="sc-plus-caption">{displayedMode === 'discuss' ? '纯文本交流，不调用工具。上下文由你决定。' : '可检查文件、分析问题；默认只读，不改动工作区。'}{record && ' 模式与模型已锁定。'}</p>
      {record ? <div className="sc-plus-model">{record.model.provider} / {record.model.model}{record.mode === 'agent' && <span>{record.permission === 'workspace-write' ? '工作区写入' : '只读'}</span>}</div> : <><label className="sc-plus-field">独立模型<select aria-label="独立模型" value={model} disabled={locked || loading} onChange={event => setModel(event.target.value)}><option value="" disabled>{loading ? '加载模型…' : '请选择模型'}</option>{models.map(item => <option key={modelKey(item)} value={modelKey(item)}>{item.name || item.model} · {item.provider}</option>)}</select></label><label className="sc-plus-check"><input type="checkbox" aria-label="继承主会话上下文" checked={inheritContext} disabled={locked} onChange={event => setInheritContext(event.target.checked)} />继承主会话上下文<span>创建时快照</span></label>{mode === 'agent' && <label className="sc-plus-field">Agent 权限<select aria-label="Agent 权限" value={permission} disabled={locked} onChange={event => { setPermission(event.target.value); setConfirmedWrite(false); }}><option value="read-only">只读 · 推荐</option><option value="workspace-write">允许写入工作区</option></select></label>}{mode === 'agent' && permission === 'workspace-write' && <div className="sc-plus-warning"><strong>与主会话共享同一工作区</strong><p>Agent 的文件修改会影响主会话；并行编辑可能冲突。没有独立副本，也不提供无限制权限。</p><label><input type="checkbox" aria-label="确认工作区写入风险" checked={confirmedWrite} onChange={event => setConfirmedWrite(event.target.checked)} disabled={locked} />我理解风险，允许写入</label></div>}</>}
      {quote && <blockquote className="sc-plus-quote"><div>引用主会话选文{!record && <button type="button" disabled={locked} onClick={() => setSelectedText('')}>移除</button>}</div><p>{quote}</p></blockquote>}
      {record?.contextChars !== undefined && <p className="sc-plus-caption">上下文快照：{record.contextChars.toLocaleString()} 字符</p>}
    </div>
    <div className="sc-plus-messages" role="log" aria-label="侧聊消息记录" aria-live="polite">{!record?.messages?.length && <div className="sc-plus-empty"><span aria-hidden="true">✦</span><strong>{loading ? '正在恢复你的侧聊…' : '一条思路，一个独立空间'}</strong><p>选择模型后发出第一条消息。<br />打开面板不会调用模型，历史会自动保存。</p></div>}{record?.messages?.map((message, index) => <article className={`sc-plus-message is-${message.role}`} key={index}><div><strong>{message.role === 'user' ? '你' : '助手'}</strong><span>{({ running: '生成中', stopped: '已停止', error: '出错' })[message.status] || ''}</span></div><p>{message.text || (message.status === 'running' ? '正在思考…' : '')}</p></article>)}</div>
    {(error || record?.error) && <div className="sc-plus-error" role="alert">{error || record.error}</div>}{notice && <div className="sc-plus-notice" role="status">{notice}</div>}
    <div className="sc-plus-composer"><textarea aria-label="侧聊消息" placeholder={displayedMode === 'agent' ? '描述想让 Agent 检查的问题…' : '围绕选文提问，或开始新的讨论…'} value={draft} disabled={locked} rows={3} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); if (!sendDisabled) void send(); } }} /><div><span>Enter 发送 · Shift + Enter 换行</span>{running ? <button type="button" className="sc-plus-stop" disabled={busy || closed} onClick={stop}>停止</button> : <button type="button" className="sc-plus-primary" disabled={sendDisabled} onClick={send}>{busy ? '处理中…' : '发送'}</button>}</div></div>
    <details className="sc-plus-conclusion"><summary>带回主线 <span>只写草稿，不会发送</span></summary><div>{lastAnswer && <button type="button" className="sc-plus-extract" onClick={() => setConclusion(lastAnswer)}>提取最后回复</button>}<textarea ref={conclusionRef} aria-label="可编辑结论" placeholder="整理结论后，追加到绑定主会话的输入草稿…" rows={3} value={conclusion} onChange={event => setConclusion(event.target.value)} /><div className="sc-plus-conclusion-actions"><button type="button" disabled={!conclusion.trim() || busy || closed} onClick={copy}>复制结论</button><button type="button" disabled={!conclusion.trim() || busy || closed} onClick={insert}>追加到主会话草稿</button></div><p className="sc-plus-caption">始终发回本侧聊绑定的主会话；保留原有草稿。</p></div></details>
  </section>;
}

export default { name: 'dsh-side-chat-plus', apply };
