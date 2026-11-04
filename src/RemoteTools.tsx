import { useEffect, useRef, useState } from 'react';
import { Terminal as XTerminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { ArrowUpRight, Check, Copy, Download, ExternalLink, ImagePlus, RefreshCw, Search, Square, X } from 'lucide-react';
import { api, baseName, errorText, id } from './api';
import { IconButton, Modal, Spinner } from './components';
import type { FileEntry, PermissionRequest, PortForward, RemoteTask } from './types';
import '@xterm/xterm/css/xterm.css';
import './remote-tools.css';

export const isImagePath = (value: string) => /\.(png|jpe?g|webp|gif)$/i.test(value);
export function remoteLink(value: string | undefined, projectPath?: string) {
  if (!value || /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(value)) return null;
  let decoded = value;
  try { decoded = decodeURIComponent(value); } catch { return null; }
  return decoded.startsWith('/') || decoded.startsWith('~/') ? decoded : projectPath ? `${projectPath}/${decoded}` : null;
}

export function RemoteImage({ path, alt, onOpen, connected = true }: { path: string; alt?: string; onOpen: (path: string) => void; connected?: boolean }) {
  const [source, setSource] = useState(''); const [error, setError] = useState(''); const [revision, setRevision] = useState(0);
  useEffect(() => { let canceled = false; setSource(''); setError(''); if (!connected) return;
    api.readMedia({ path }).then(result => { if (!canceled) setSource(result.dataUrl); }).catch(error => { if (!canceled) setError(errorText(error)); });
    return () => { canceled = true; };
  }, [path, connected, revision]);
  return <span className="remote-image"><button onClick={() => source ? onOpen(path) : setRevision(r => r + 1)} title={error || path} disabled={!connected}>
    {source ? <img src={source} alt={alt || baseName(path)} loading="lazy" /> : <span><ImagePlus size={18} />{!connected ? '连接后查看图片' : error ? '图片加载失败 · 点击重试' : '正在读取图片…'}</span>}
  </button></span>;
}

export function ImagePreview({ path, onClose, onDownload }: { path: string; onClose: () => void; onDownload: (path: string) => void }) {
  const [source, setSource] = useState(''); const [error, setError] = useState(''); const [zoom, setZoom] = useState(false); const [copied, setCopied] = useState(false);
  useEffect(() => { let canceled = false; api.readMedia({ path }).then(result => { if (!canceled) setSource(result.dataUrl); }).catch(error => { if (!canceled) setError(errorText(error)); }); return () => { canceled = true; }; }, [path]);
  return <Modal title={baseName(path)} subtitle="点击图片切换原始尺寸" onClose={onClose} wide><div className="media-actions"><button onClick={() => onDownload(path)}><Download size={15} />保存到 Windows</button><button disabled={!source} onClick={() => { void api.copyImage({ path }).then(() => setCopied(true)).catch(e => setError(errorText(e))); }}>{copied ? <Check size={15} /> : <Copy size={15} />}{copied ? '已复制' : '复制图片'}</button><button onClick={() => { void api.openLocalFile({ path }).catch(e => setError(errorText(e))); }}><ExternalLink size={15} />本地应用打开</button></div>{error && <p className="feature-error">{error}</p>}<div className={`image-preview ${zoom ? 'original-size' : ''}`}>{source ? <img src={source} alt={baseName(path)} onClick={() => setZoom(v => !v)} /> : !error && <Spinner />}</div></Modal>;
}

export function FilePicker({ projectPath, initialQuery = '', onSelect, onClose }: { projectPath: string; initialQuery?: string; onSelect: (path: string) => void; onClose: () => void }) {
  const [query, setQuery] = useState(initialQuery); const [files, setFiles] = useState<FileEntry[]>([]); const [error, setError] = useState(''); const [loading, setLoading] = useState(false); const [truncated, setTruncated] = useState(false);
  useEffect(() => { let canceled = false; const timer = setTimeout(() => { setLoading(true); setError(''); void api.searchFiles({ projectPath, query }).then(result => { if (!canceled) { setFiles(result.files); setTruncated(result.truncated); } }).catch(e => { if (!canceled) setError(errorText(e)); }).finally(() => { if (!canceled) setLoading(false); }); }, 180); return () => { canceled = true; clearTimeout(timer); }; }, [projectPath, query]);
  return <Modal title="引用项目文件" subtitle="搜索文件名或路径，选择后加入当前消息" onClose={onClose}><div className="feature-search"><Search size={16} /><input value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索项目文件" aria-label="搜索项目文件" /></div>{loading && <Spinner />}{error && <p className="feature-error">{error}</p>}<div className="file-picker-list">{files.map(file => <button key={file.path} onClick={() => { onSelect(file.path); onClose(); }}>{file.path.slice(projectPath.length + 1)}</button>)}{!loading && !files.length && <p>没有匹配的文件</p>}</div>{truncated && <p className="feature-note">显示部分结果，可缩小搜索范围。</p>}</Modal>;
}

export function PortsPanel({ onClose }: { onClose: () => void }) {
  const [ports, setPorts] = useState<PortForward[]>([]); const [remotePort, setRemotePort] = useState('3000'); const [localPort, setLocalPort] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const refresh = () => api.listPorts().then(setPorts).catch(e => setError(errorText(e)));
  useEffect(() => { void refresh(); }, []);
  return <Modal title="远端网页与端口" subtitle="通过当前 SSH 连接访问远端服务，本地端口留空则自动分配" onClose={onClose}>
    <form className="port-form" onSubmit={e => { e.preventDefault(); setBusy(true); setError(''); void api.forwardPort({ remotePort: Number(remotePort), localPort: Number(localPort || 0) }).then(refresh).catch(e => setError(errorText(e))).finally(() => setBusy(false)); }}>
      <label>远端端口<input type="number" min="1" max="65535" value={remotePort} onChange={e => setRemotePort(e.target.value)} required /></label><label>本地端口<input type="number" min="1" max="65535" value={localPort} onChange={e => setLocalPort(e.target.value)} placeholder="自动" /></label><button className="primary-button" disabled={busy}>{busy ? '正在连接…' : '建立转发'}</button>
    </form>{error && <p className="feature-error">{error}</p>}<div className="port-list">{ports.map(port => <div key={port.id}><span>远端 {port.remotePort} → 本地 {port.localPort}</span><button onClick={() => void api.openExternal?.({ url: port.url })}>打开<ArrowUpRight size={14} /></button><IconButton label={`关闭端口 ${port.remotePort}`} onClick={() => void api.closePort({ id: port.id }).then(refresh)}><X size={14} /></IconButton></div>)}{!ports.length && <p className="feature-note">先在远端启动 WebUI、Jupyter 或开发服务器，再添加对应端口。</p>}</div>
  </Modal>;
}

export function InteractiveTerminal({ projectPath, connected, login = false, onClose, onReference }: { projectPath: string; connected: boolean; login?: boolean; onClose: () => void; onReference: (text: string) => void }) {
  const host = useRef<HTMLDivElement>(null); const termRef = useRef<XTerminal | null>(null); const job = useRef(''); const [error, setError] = useState(''); const [links, setLinks] = useState<string[]>([]); const [connectedTerminal, setConnectedTerminal] = useState(false); const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!host.current || !connected) return;
    const terminal = new XTerminal({ cursorBlink: true, fontFamily: 'Cascadia Code, Consolas, monospace', fontSize: 12, scrollback: 5000, theme: { background: '#252723', foreground: '#e7e5dd', cursor: '#dba485', selectionBackground: '#65705b88' } });
    const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(host.current); fit.fit(); termRef.current = terminal;
    const jobId = id(); job.current = jobId; let canceled = false; let ready = false; let linkBuffer = '';
    setConnectedTerminal(false); setError(''); setLinks([]);
    const unsubscribe = api.onEvent(event => {
      if (event.kind !== 'terminal' || event.jobId !== jobId) return;
      if (event.type === 'data' || event.type === 'error') {
        const data = event.data || ''; terminal.write(data); linkBuffer = (linkBuffer + data).slice(-16000);
        const matches = [...linkBuffer.matchAll(/https?:\/\/[^\s<>"\x1b\x07]+/g)].map(m => m[0].replace(/[),.;]+$/, ''));
        if (matches.length) setLinks(old => [...new Set([...old, ...matches])].slice(-8));
      }
      if (event.type === 'exit') { ready = false; setConnectedTerminal(false); terminal.write(`\r\n[终端已结束 · ${event.code ?? event.signal ?? ''}]\r\n`); }
    });
    const input = terminal.onData(data => { if (ready) void api.writeJob({ jobId, data }).catch(e => setError(errorText(e))); });
    const resize = () => { fit.fit(); if (ready) void api.resizeTerminal({ jobId, cols: terminal.cols, rows: terminal.rows }).catch(() => {}); };
    const observer = new ResizeObserver(resize); observer.observe(host.current);
    void api.openTerminal({ jobId, projectPath, cols: terminal.cols, rows: terminal.rows, login }).then(() => { if (canceled) { void api.stopJob({ jobId }).catch(() => {}); return; } ready = true; setConnectedTerminal(true); terminal.focus(); resize(); }).catch(e => { if (!canceled) setError(errorText(e)); });
    return () => { canceled = true; unsubscribe(); input.dispose(); observer.disconnect(); terminal.dispose(); termRef.current = null; if (ready) void api.stopJob({ jobId }).catch(() => {}); };
  }, [projectPath, connected, login, revision]);
  return <div className="interactive-terminal"><div className="interactive-toolbar"><strong>{login ? 'Claude 登录' : '交互终端'}</strong><span>{connectedTerminal ? '已连接' : '未连接'}</span><button onClick={() => { const text = termRef.current?.getSelection(); if (text) onReference(text); }}>选中内容发到聊天</button><IconButton label="重开终端" onClick={() => setRevision(r => r + 1)}><RefreshCw size={14} /></IconButton><IconButton label="关闭交互终端" onClick={onClose}><X size={14} /></IconButton></div>{error && <p className="feature-error">{error}</p>}<div className="xterm-host" ref={host} />{links.length > 0 && <div className="terminal-links">{links.map(url => <button key={url} title={url} onClick={() => { void (async () => { const parsed = new URL(url); if (['localhost', '127.0.0.1', '0.0.0.0', '[::1]'].includes(parsed.hostname) && !login) { const port = await api.forwardPort({ remotePort: Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80)) }); parsed.hostname = '127.0.0.1'; parsed.port = String(port.localPort); } await api.openExternal?.({ url: parsed.href }); })().catch(e => setError(errorText(e))); }}><ExternalLink size={12} />{login ? '在本地浏览器登录' : url}</button>)}</div>}{login && <p className="feature-note">打开登录链接后，将验证码粘贴回上方终端，按 Enter 继续。</p>}</div>;
}

export function RequestCard({ request, task, onDone }: { request: PermissionRequest; task: RemoteTask; onDone: () => void }) {
  const [answers, setAnswers] = useState<Record<string, string>>({}); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const questions = request.request.tool_name === 'AskUserQuestion' && Array.isArray(request.request.input.questions) ? request.request.input.questions as Array<{ question: string; options?: { label: string; description?: string }[]; multiSelect?: boolean }> : [];
  const reply = (allow: boolean) => { setBusy(true); setError(''); void api.replyTask({ projectPath: task.projectPath, jobId: task.jobId, requestId: request.request_id, allow, answers }).then(onDone).catch(e => { setError(errorText(e)); setBusy(false); }); };
  return <div className="request-card"><strong>{questions.length ? 'Claude 需要你的回答' : `允许 ${request.request.tool_name}？`}</strong>{request.request.decision_reason && <p>{request.request.decision_reason}</p>}{questions.length ? questions.map(question => <fieldset key={question.question}><legend>{question.question}</legend>{question.options?.map(option => <label key={option.label} title={option.description}><input type={question.multiSelect ? 'checkbox' : 'radio'} name={`${request.request_id}-${question.question}`} checked={question.multiSelect ? (answers[question.question] || '').split(', ').includes(option.label) : answers[question.question] === option.label} onChange={() => setAnswers(old => { const selected = (old[question.question] || '').split(', ').filter(Boolean); return { ...old, [question.question]: question.multiSelect ? (selected.includes(option.label) ? selected.filter(v => v !== option.label) : [...selected, option.label]).join(', ') : option.label }; })} />{option.label}</label>)}<input aria-label={`${question.question} 自定义回答`} value={answers[question.question] || ''} onChange={e => setAnswers(old => ({ ...old, [question.question]: e.target.value }))} placeholder="也可以输入自己的回答" /></fieldset>) : <pre>{JSON.stringify(request.request.input, null, 2)}</pre>}{error && <p className="feature-error">{error}</p>}<div className="request-actions"><button disabled={busy} onClick={() => reply(false)}>拒绝</button><button className="primary-button" disabled={busy || !!questions.length && questions.some(q => !answers[q.question]?.trim())} onClick={() => reply(true)}>{busy ? '正在提交…' : questions.length ? '提交回答' : '仅允许这一次'}</button></div></div>;
}

const labels: Record<string, string> = { starting: '启动中', running: '运行中', waiting: '等待回答', completed: '已完成', failed: '失败', stopped: '已停止', interrupted: '已中断' };
export function TaskPanel({ projectPath, onClose, onAttach }: { projectPath: string; onClose: () => void; onAttach: (task: RemoteTask) => void }) {
  const [tasks, setTasks] = useState<RemoteTask[]>([]); const [error, setError] = useState('');
  const refresh = () => api.listTasks({ projectPath }).then(result => { setTasks(result.tasks); setError(''); }).catch(e => setError(errorText(e)));
  useEffect(() => { let canceled = false; const run = () => { if (!canceled) void refresh(); }; run(); const timer = setInterval(run, 5000); return () => { canceled = true; clearInterval(timer); }; }, [projectPath]);
  return <Modal title="远端任务" subtitle="任务输出保留在远端，重连后可接回；远端重启或结束进程会中断任务" onClose={onClose} wide>{error && <p className="feature-error">{error}</p>}<div className="task-list">{tasks.map(task => <div key={task.jobId}><div><strong>{task.title || 'Claude 任务'}</strong><span>{labels[task.state]} · {new Date(task.createdAt).toLocaleString()}</span>{task.message && <p>{task.message}</p>}</div><button className="secondary-button" onClick={() => { onAttach(task); onClose(); }}>{['running', 'waiting', 'starting'].includes(task.state) ? '接回任务' : '查看结果'}</button>{['running', 'waiting', 'starting'].includes(task.state) && <IconButton label={`停止任务 ${task.title}`} onClick={() => void api.stopTask({ projectPath, jobId: task.jobId }).then(refresh).catch(e => setError(errorText(e)))}><Square size={14} /></IconButton>}</div>)}{!tasks.length && !error && <p className="feature-note">暂无任务。开启“断线后继续运行”后发送消息，任务会保存在这里。</p>}</div></Modal>;
}
