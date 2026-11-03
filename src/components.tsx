import { useEffect, useRef, type ReactNode } from 'react';
import { X, LoaderCircle, FileCode2, FileText, Folder, Braces, Download, CheckCircle2, AlertCircle, ArrowUpRight, ChevronDown } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api, baseName } from './api';
import type { Message } from './types';

export function Star({ size = 42 }: { size?: number }) {
  return <img src={new URL('./assets/claude-spark.svg', import.meta.url).href} width={size} height={size} alt="" aria-hidden="true" className="brand-star" draggable={false} />;
}
export function IconButton({ label, children, onClick, disabled, className = '' }: { label: string; children: ReactNode; onClick?: () => void; disabled?: boolean; className?: string }) {
  return <button className={`icon-button ${className}`} aria-label={label} title={label} onClick={onClick} disabled={disabled}>{children}</button>;
}
export function Spinner() { return <LoaderCircle size={16} className="spin" aria-label="处理中" />; }
export function FileIcon({ name, directory = false, size = 16 }: { name: string; directory?: boolean; size?: number }) {
  return directory ? <Folder size={size} className="folder-icon" /> : /\.(py|js|jsx|ts|tsx|sh|cpp|c|h|rs)$/.test(name) ? <FileCode2 size={size} className="code-icon" /> : /\.(json|yml|yaml)$/.test(name) ? <Braces size={size} /> : <FileText size={size} />;
}
export function Modal({ title, subtitle, children, onClose, wide = false }: { title: string; subtitle?: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    ref.current?.querySelector<HTMLElement>('input, button, select')?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeRef.current();
      if (event.key === 'Tab') {
        const items = ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]');
        if (!items?.length) return;
        const first = items[0], last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('keydown', key); previous?.focus(); };
  }, []);
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><div role="dialog" aria-modal="true" aria-label={title} className={`modal ${wide ? 'wide' : ''}`} ref={ref}><div className="modal-heading"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div><IconButton label="关闭窗口" onClick={onClose}><X size={18} /></IconButton></div>{children}</div></div>;
}
export function MessageView({ message, streaming, onDownload, onOpen }: { message: Message; streaming?: boolean; onDownload: (path: string) => void; onOpen: (path: string) => void }) {
  if (message.role === 'user') return <article className="message user-message"><div className="user-bubble">{message.content}</div></article>;
  return <article className={`message assistant-message ${message.error ? 'has-error' : ''}`}><div className="assistant-label"><Star size={23} /><span>Claude</span>{streaming && <span className="working-label"><Spinner />正在处理</span>}</div>
    {message.tools?.length ? <div className="tool-list">{message.tools.map(tool => <details key={tool.id} className="tool-call"><summary>{tool.result ? <CheckCircle2 size={14} /> : <Braces size={14} />}<span>{tool.name}</span><span className="tool-subtitle">{typeof tool.input === 'object' && tool.input && 'file_path' in tool.input ? baseName(String(tool.input.file_path)) : '查看详情'}</span><ChevronDown size={13} /></summary><pre>{JSON.stringify(tool.input, null, 2)}</pre>{tool.result && <pre className="tool-result">{tool.result}</pre>}</details>)}</div> : null}
    <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ href, children }) => <a href={href} onClick={e => { e.preventDefault(); if (href && /^https?:\/\//.test(href)) void api.openExternal?.({ url: href }); }}>{children}<ArrowUpRight size={12} /></a>, img: ({ alt }) => <span className="image-placeholder">[图片：{alt || '远程图片'}]</span> }}>{message.content || (streaming ? '正在读取项目上下文…' : '')}</ReactMarkdown>{streaming && message.content && <span className="stream-caret" />}</div>
    {message.files?.length ? <div className="message-files">{[...new Set(message.files)].map(path => <div className="file-card" key={path}><button className="file-card-open" onClick={() => onOpen(path)} title={path}><FileIcon name={path} size={20} /><span><strong>{baseName(path)}</strong></span></button><IconButton label={`下载 ${baseName(path)} 到 Windows`} onClick={() => onDownload(path)}><Download size={17} /></IconButton></div>)}</div> : null}
    {message.error && <span className="message-error"><AlertCircle size={14} />本次请求未完整完成</span>}
  </article>;
}
