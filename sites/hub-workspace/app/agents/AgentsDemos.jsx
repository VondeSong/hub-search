'use client';

import { useEffect, useRef, useState } from 'react';
import { AssistantAnswerActions } from '../AssistantAnswerActions';
import AssistantAnswerContent from '../AssistantAnswerContent';
import { AssistantProcessDemo } from '../AssistantProcess';
import { MIGRATED_HUB_ITEMS } from '../insight-migration';
import { agentDemoModes, formattingDemoMessages, sourceDemoIds, sourceDemoQuestion, sourceDemoAnswer, sourceDemoSections } from './demo-data';
import answerStyles from './demo-answer.css?inline';
import processStyles from './demo-process.css?inline';
import demoStyles from './demo-shell.css?inline';

const sampleSources = sourceDemoIds.map(id => {
  const page = MIGRATED_HUB_ITEMS.find(item => item.id === id);
  return { id, title: page.title, path: page.space, text: page.sections.map(section => section.text || section.items?.join('\n') || '').join('\n\n') };
});

const actions = { insert: '插入页面', note: '新建笔记', task: '创建任务' };
const widths = [['sidebar', '侧栏 480px'], ['focus', '专注 780px'], ['full', '全屏']];

export default function AgentsDemos({ initialMode, onDismiss, onModeChange, sourcePages = sampleSources, insertTargets, onOpenSource, onApply, processAssets }) {
  const [mode, setMode] = useState(initialMode);
  const [width, setWidth] = useState('focus');
  const [copied, setCopied] = useState('');
  const [notice, setNotice] = useState('');
  const [preview, setPreview] = useState(null);
  const [working, setWorking] = useState(false);
  const [jump, setJump] = useState(false);
  const scroll = useRef(null);
  const content = useRef(null);
  const dialog = useRef(null);
  const following = useRef(true);
  const submitting = useRef(false);
  const sourcesById = new Map(sourcePages.map(page => [page.id, page]));
  const sourceReady = sourceDemoIds.every(id => sourcesById.has(id));
  const previewSource = preview?.kind === 'source' ? sourcesById.get(preview.id) : undefined;
  const previewOpen = !!preview && (!preview.ids?.length || preview.ids.every(id => sourcesById.has(id)))
    && (preview.kind !== 'source' || !!previewSource);

  useEffect(() => {
    const panel = dialog.current;
    if (!previewOpen || !panel) return;
    panel.showModal();
    return () => { if (panel.open) panel.close(); };
  }, [previewOpen]);

  useEffect(() => {
    const viewport = scroll.current;
    const body = content.current;
    if (!working || !viewport || !body) return;
    const observer = new ResizeObserver(() => {
      if (following.current) viewport.scrollTop = viewport.scrollHeight;
    });
    observer.observe(body);
    return () => observer.disconnect();
  }, [working]);

  function changeMode(next) {
    if (mode === next) return;
    setMode(next);
    setNotice('');
    setCopied('');
    setJump(false);
    following.current = true;
    if (scroll.current) scroll.current.scrollTop = 0;
    onModeChange?.(next);
  }

  function showAction(kind, title, body, ids) {
    setNotice('');
    setPreview({ kind, title, body, ids, target: (insertTargets ?? sampleSources)[0]?.id || '', expectedBody: (insertTargets ?? sampleSources)[0]?.text || '', error: '' });
  }

  async function applyPreview() {
    if (!onApply || !preview || !previewOpen || submitting.current) return;
    submitting.current = true;
    setPreview(value => ({ ...value, busy: true, error: '' }));
    try {
      await onApply(preview);
      setPreview(null);
    } catch (error) {
      setPreview(value => value && ({ ...value, busy: false, error: error instanceof Error ? error.message : '演示操作未完成，请重试。' }));
    } finally {
      submitting.current = false;
    }
  }

  function answerActions(id, text, title, ids = []) {
    return <AssistantAnswerActions copied={copied === id} onCopy={async () => {
      try { await navigator.clipboard.writeText(text); setCopied(id); setNotice(''); }
      catch { setNotice('无法访问剪贴板，请选中文字复制。'); }
    }} onInsert={() => showAction('insert', title, text, ids)}
      onNote={() => showAction('note', title, text, ids)} onTask={() => showAction('task', title, text, ids)}/>;
  }

  return <>
    <style>{answerStyles + processStyles + demoStyles}</style>
    <div className="agents-demo-frame" data-width={width}
      style={processAssets ? { '--demo-github-icon': `url("${processAssets.githubIcon}")` } : undefined}>
      <div className="agents-demo-top">
        <button type="button" autoFocus onClick={onDismiss}>返回工作台</button>
        <div className="agents-demo-switch" role="group" aria-label="界面宽度">
          {widths.map(([id, label]) => <button type="button" key={id} aria-pressed={width === id} onClick={() => setWidth(id)}>{label}</button>)}
        </div>
      </div>
      <section className="agents-demo-panel ha-panel" aria-label="Agents 演示">
        <header className="agents-demo-header">
          <h1>Hub Agents</h1><span>演示 · 不调用模型</span>
          <div className="agents-demo-switch" role="group" aria-label="选择 Agents 演示">
            {agentDemoModes.map(([id, label]) => <button type="button" key={id} aria-pressed={mode === id} onClick={() => changeMode(id)}>{label}</button>)}
          </div>
        </header>
        <div className="agents-demo-scroll ha-messages" ref={scroll} onScroll={event => {
          const viewport = event.currentTarget;
          following.current = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 24;
          setJump(!following.current);
        }}>
          <main ref={content} className="agents-demo-body">
            {mode === 'activity-demo' ? <AssistantProcessDemo onClose={() => changeMode('ui-demo')} onWorkingChange={setWorking} assets={processAssets}/>
              : mode === 'source-demo' ? sourceReady ? <>
                <p className="agents-demo-question">{sourceDemoQuestion}</p>
                <AssistantAnswerContent text={sourceDemoAnswer}/>
                {sourceDemoSections.map(section => <section key={section.heading} className="ha-reply-section">
                  <h3>{section.heading}</h3><AssistantAnswerContent text={section.body}/>
                  {section.sourceIds.map(id => <button key={id} type="button" className="agents-demo-citation"
                    onClick={() => setPreview({ kind: 'source', id })}>来源 · {sourcesById.get(id).title}</button>)}
                </section>)}
                {answerActions('sources', [sourceDemoAnswer, ...sourceDemoSections.map(section => section.heading + '\n' + section.body)].join('\n\n'), '卡扣试装核对', sourceDemoIds)}
              </> : <p role="status">这组演示的来源当前不可用。恢复来源访问后可查看对照与引文。</p>
              : formattingDemoMessages.map(message => message.role === 'user'
                ? <p key={message.id} className="agents-demo-question">{message.text}</p>
                : <div key={message.id} className="agents-demo-reply">
                  <AssistantAnswerContent text={message.text}/>
                  {answerActions(message.id, message.text, 'PowerShell 分数筛选')}
                </div>)}
            {notice && <p role="status">{notice}</p>}
          </main>
        </div>
        {mode === 'activity-demo' && jump && <button type="button" className="agents-demo-latest" onClick={() => {
          following.current = true;
          if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
        }}>回到最新</button>}
        {previewOpen && <dialog ref={dialog} className="agents-demo-preview" aria-label={previewSource ? '来源预览' : actions[preview.kind]}
          onCancel={event => { event.preventDefault(); event.stopPropagation(); if (!submitting.current) setPreview(null); }}>
          {previewSource ? <>
            <h2>{previewSource.title}</h2><p>{previewSource.path}</p>
            <div className="agents-demo-original">{previewSource.text}</div>
            <footer>
              <button type="button" onClick={() => setPreview(null)}>关闭预览</button>
              {onOpenSource && <button type="button" onClick={() => onOpenSource(previewSource.id)}>在工作台打开原文</button>}
            </footer>
          </> : <>
            <h2>{actions[preview.kind]} · 预览</h2>
            {preview.kind === 'insert' ? <label>目标页面
              <select value={preview.target} onChange={event => {
                const target = event.target.value;
                const expectedBody = (insertTargets ?? sampleSources).find(page => page.id === target)?.text || '';
                setPreview(value => ({ ...value, target, expectedBody }));
              }}>
                {(insertTargets ?? sampleSources).map(page => <option key={page.id} value={page.id}>{page.title}</option>)}
              </select></label> : <label>标题
              <input value={preview.title} onChange={event => {
                const title = event.target.value;
                setPreview(value => ({ ...value, title }));
              }}/></label>}
            <label>内容<textarea rows={6} value={preview.body} readOnly={preview.kind === 'insert'} onChange={event => {
              const body = event.target.value;
              setPreview(value => ({ ...value, body }));
            }}/></label>
            {preview.error && <p role="alert">{preview.error}</p>}
            <footer>
              <button type="button" disabled={preview.busy} onClick={() => setPreview(null)}>{onApply ? '取消' : '关闭预览'}</button>
              {onApply && <button type="button" disabled={preview.busy || !preview.body.trim() || !(preview.kind === 'insert' ? preview.target : preview.title.trim())}
                onClick={applyPreview}>{preview.kind === 'insert' ? '确认追加' : '保存到浏览器演示数据'}</button>}
            </footer>
          </>}
        </dialog>}
      </section>
    </div>
  </>;
}
