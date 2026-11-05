import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowUp, AtSign, Check, CheckCircle2, ChevronDown, ChevronRight, Circle, Code2, Download, Ellipsis, FilePlus2, Folder, FolderOpen, FolderPlus, FolderUp, GitCompareArrows, HardDrive, KeyRound, LoaderCircle, MessageSquare, PanelLeftClose, PanelRightClose, PanelRightOpen, Paperclip, Play, Plus, RefreshCw, Save, Search, Settings2, ShieldCheck, Square, Terminal, Upload, Wifi, WifiOff, X } from 'lucide-react';
import CodeMirror from '@uiw/react-codemirror';
import { python } from '@codemirror/lang-python';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { api, baseName, cleanTerminalOutput, defaultConnection, emptyState, errorText, formatBytes, id, isDesktop, shellQuote } from './api';
import { FileIcon, IconButton, MessageView, Modal, Spinner, Star } from './components';
import { UsagePanel } from './UsagePanel';
import { chatCommands, localChatCommand, terminalCommands } from './commands';
import { CommandSuggestions, isComposingInput, useCommandSuggestions } from './CommandSuggestions';
import type { AppState, ConnectionConfig, ConnectionInfo, Conversation, FileEntry, Message, Project, RemoteEvent, UploadProgressData } from './types';
import { useProjectHistory } from './useProjectHistory';
import { UploadProgress } from './UploadProgress';
import { UpdateControl } from './UpdateControl';
import './sessions.css';
import { ClipboardPaste, Globe, ListTodo, LogIn } from 'lucide-react';
import { FilePicker, ImagePreview, InteractiveTerminal, PortsPanel, RequestCard, TaskPanel, isImagePath } from './RemoteTools';
import type { Attachment, RemoteTask } from './types';

type OpenFile = { path: string; content: string; original: string; mtime: number; size: number };
type ChatRun = { id: string; conversationId: string; messageId: string; confirmed: string; pending: string; seen: Set<string>; hasResult: boolean; persistent?: boolean; projectPath?: string };
type Toast = { text: string; error?: boolean; path?: string };
const stripSecrets = ({ password: _password, passphrase: _passphrase, ...config }: ConnectionConfig) => config;
const configKey = (config: ConnectionConfig) => `${config.username}@${config.host}:${config.port}:${config.workspace}`;
const credentialKey = (config: ConnectionConfig) => JSON.stringify([config.host, config.port, config.username, config.authType, config.authType === 'key' ? config.privateKeyPath || '' : '']);
const connectionSettingsKey = (config: ConnectionConfig) => JSON.stringify([credentialKey(config), config.workspace, config.claudePath]);

export default function App() {
  const [state, setState] = useState<AppState>(emptyState);
  const [loaded, setLoaded] = useState(false);
  const [activeProjectId, setActiveProjectId] = useState('');
  const [activeConversationId, setActiveConversationId] = useState('');
  const [connection, setConnection] = useState<ConnectionInfo | null>(null);
  const [connectionGeneration, setConnectionGeneration] = useState(0);
  const [usageRevision, setUsageRevision] = useState(0);
  const [usageRevealRevision, setUsageRevealRevision] = useState(0);
  const [connecting, setConnecting] = useState(false);
  const connectingRef = useRef(false);
  const startupAttemptedRef = useRef(false);
  const [configSaving, setConfigSaving] = useState(false);
  const [connectionModal, setConnectionModal] = useState(false);
  const [draftConnection, setDraftConnection] = useState<ConnectionConfig>(defaultConnection);
  const [connectionError, setConnectionError] = useState('');
  const [projectModal, setProjectModal] = useState(false);
  const [projectMode, setProjectMode] = useState<'create' | 'open'>('create');
  const [projectName, setProjectName] = useState('');
  const [projectPath, setProjectPath] = useState('');
  const [projectBusy, setProjectBusy] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);
  const [panelWidth, setPanelWidth] = useState(420);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [tab, setTab] = useState<'files' | 'code' | 'diff'>('files');
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [directory, setDirectory] = useState('');
  const [fileFilter, setFileFilter] = useState('');
  const [filesLoading, setFilesLoading] = useState(false);
  const [filesRevision, setFilesRevision] = useState(0);
  const [fileError, setFileError] = useState('');
  const [openFile, setOpenFile] = useState<OpenFile | null>(null);
  const [fileBusy, setFileBusy] = useState(false);
  const [uploadBusy, setUploadBusy] = useState<'files' | 'folder' | null>(null);
  const [uploadProgress, setUploadProgress] = useState<UploadProgressData | null>(null);
  const uploadBusyRef = useRef(false);
  const [newFileModal, setNewFileModal] = useState(false);
  const [newFileName, setNewFileName] = useState('');
  const [diff, setDiff] = useState<{ diff: string; isGit: boolean } | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const attachmentBusyRef = useRef(false);
  const [dropActive, setDropActive] = useState(false);
  const [imagePath, setImagePath] = useState('');
  const [filePicker, setFilePicker] = useState(false);
  const [portsOpen, setPortsOpen] = useState(false);
  const [tasksOpen, setTasksOpen] = useState(false);
  const [interactiveTerminal, setInteractiveTerminal] = useState<'shell' | 'login' | null>(null);
  const [durableTasks, setDurableTasks] = useState(true);
  const [askCommands, setAskCommands] = useState(false);
  const [notifications, setNotifications] = useState(true);
  const notificationsRef = useRef(notifications); notificationsRef.current = notifications;
  const [persistentReady, setPersistentReady] = useState('');
  const [activeTask, setActiveTask] = useState<RemoteTask | null>(null);
  const [taskPollError, setTaskPollError] = useState('');
  const chatEvent = useRef<(event: RemoteEvent) => void>(() => {});
  const [editorSelection, setEditorSelection] = useState('');
  const [references, setReferences] = useState<string[]>([]);
  const folderReferencePaths = useRef(new Set<string>());
  const [mode, setMode] = useState<'plan' | 'edit'>('edit');
  const [allowCommands, setAllowCommands] = useState(true);
  const [permissionModal, setPermissionModal] = useState(false);
  const [commandHelpModal, setCommandHelpModal] = useState(false);
  const [chatRun, setChatRun] = useState<{ id: string; conversationId: string; messageId: string } | null>(null);
  const runRef = useRef<ChatRun | null>(null);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [terminalOutput, setTerminalOutput] = useState('');
  const [terminalCommand, setTerminalCommand] = useState('');
  const [terminalJob, setTerminalJob] = useState<string | null>(null);
  const terminalRef = useRef<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [transfer, setTransfer] = useState<RemoteEvent | null>(null);
  const [taskStatus, setTaskStatus] = useState('就绪');
  const chatBottom = useRef<HTMLDivElement>(null);
  const terminalBottom = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const terminalInputRef = useRef<HTMLInputElement>(null);
  const chatCompletion = useCommandSuggestions({ value: prompt, onChange: setPrompt, commands: chatCommands, inputRef: composerRef, mode: 'chat' });
  const terminalCompletion = useCommandSuggestions({ value: terminalCommand, onChange: setTerminalCommand, commands: terminalCommands(openFile?.path), inputRef: terminalInputRef, mode: 'terminal', disabled: !!terminalJob || !connection });
  const stateRef = useRef(state);
  const connectionRef = useRef(connection);
  const dirty = !!openFile && openFile.content !== openFile.original;
  const visibleProjects = state.projects.filter(p => p.connectionKey === configKey(state.connection));
  const project = visibleProjects.find(p => p.id === activeProjectId);
  const conversation = state.conversations.find(c => c.id === activeConversationId && c.projectId === project?.id);
  const conversations = state.conversations.filter(c => c.projectId === activeProjectId).sort((a, b) => b.updatedAt - a.updatedAt);
  const connected = !!connection;
  const uploadContextRef = useRef({ projectId: activeProjectId, conversationId: activeConversationId, connection, generation: connectionGeneration, directory });
  uploadContextRef.current = { projectId: activeProjectId, conversationId: activeConversationId, connection, generation: connectionGeneration, directory };
  const savedCredentialMatches = !!state.connection.credentialSaved && credentialKey(state.connection) === credentialKey(draftConnection);
  const canSaveConnectionSettings = !connecting && !configSaving && (!connected || connectionSettingsKey(state.connection) === connectionSettingsKey(draftConnection));

  useEffect(() => { stateRef.current = state; }, [state]);
  useEffect(() => { connectionRef.current = connection; }, [connection]);
  const projectHistory = useProjectHistory({ project, conversation, connection, generation: connectionGeneration, stateRef, setState, setActiveConversationId });
  useEffect(() => {
    for (const path of folderReferencePaths.current) {
      if (!references.includes(path)) folderReferencePaths.current.delete(path);
    }
  }, [references]);
  const notify = useCallback((text: string, error = false, path?: string) => setToast({ text, error, path }), []);
  useEffect(() => { if (toast) { const timer = setTimeout(() => setToast(null), toast.error ? 9000 : 5000); return () => clearTimeout(timer); } }, [toast]);
  useEffect(() => {
    let canceled = false;
    api.loadState().then(saved => {
      if (canceled) return;
      const next = { ...emptyState, ...saved, connection: { ...defaultConnection, ...saved.connection } };
      next.projects = next.projects.map(p => ({ ...p, connectionKey: p.connectionKey || configKey(next.connection) }));
      setState(next); setDraftConnection(next.connection);
      const firstId = next.settings?.activeProjectId || next.projects[0]?.id || '';
      setActiveProjectId(firstId);
      setActiveConversationId(next.settings?.activeConversationId || next.conversations.find(c => c.projectId === firstId)?.id || '');
      setPanelWidth(Math.max(330, Math.min(700, next.settings?.panelWidth || 420)));
      setAllowCommands(next.settings?.allowCommands ?? true);
      setDurableTasks(next.settings?.durableTasks ?? true);
      setAskCommands(next.settings?.askCommands ?? false);
      setNotifications(next.settings?.notifications ?? true);
      setLoaded(true);
    }).catch(error => { if (!canceled) notify(`无法读取本地记录，已暂停自动保存以保留原文件：${errorText(error)}`, true); });
    return () => { canceled = true; };
  }, [notify]);
  useEffect(() => {
    if (!loaded) return;
    void api.saveState({ ...state, connection: stripSecrets(state.connection), settings: { ...state.settings, activeProjectId, activeConversationId, panelWidth, allowCommands, durableTasks, askCommands, notifications } }).catch(error => notify(`会话保存失败：${errorText(error)}`, true));
  }, [state, loaded, activeProjectId, activeConversationId, panelWidth, allowCommands, durableTasks, askCommands, notifications, notify]);
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', handler); return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);
  useEffect(() => { chatBottom.current?.scrollIntoView({ behavior: 'instant', block: 'end' }); }, [conversation?.messages]);
  useEffect(() => { terminalBottom.current?.scrollIntoView({ behavior: 'instant', block: 'end' }); }, [terminalOutput]);

  const updateAssistant = useCallback((run: ChatRun, update: (message: Message) => Message, sessionId?: string) => {
    setState(current => ({ ...current, conversations: current.conversations.map(c => c.id === run.conversationId ? { ...c, sessionId: sessionId || c.sessionId, messages: c.messages.map(m => m.id === run.messageId ? update(m) : m), updatedAt: Date.now() } : c) }));
  }, []);

  useEffect(() => { const handler = (event: RemoteEvent) => {
    if (event.kind === 'navigate' && event.conversationId) { const target = stateRef.current.conversations.find(c => c.id === event.conversationId); if (target) { setActiveProjectId(target.projectId); setActiveConversationId(target.id); } return; }
    if (event.kind === 'tunnel' && event.type === 'error') { notify(event.data || '端口连接失败', true); return; }
    if (event.kind === 'connection') {
      if (event.status === 'error') { setTaskStatus('连接异常'); if (event.message) notify(event.message, true); return; }
      uploadContextRef.current.connection = null;
      setConnection(null); setTaskStatus('连接中断'); setPersistentReady(''); setActiveTask(null); setTaskPollError('');
      if (runRef.current) {
        const run = runRef.current;
        updateAssistant(run, message => ({ ...message, content: `${message.content}\n\n${run.persistent ? '连接已中断，重连后将接回远端任务。' : '连接已中断，远端任务状态待确认。'}`, error: !run.persistent }));
        runRef.current = null; setChatRun(null);
      }
      if (terminalRef.current) { setTerminalOutput(s => `${s}\n[连接中断，远端进程状态待确认]\n`); terminalRef.current = null; setTerminalJob(null); }
      if (event.message) notify(event.message, event.status === 'error');
      return;
    }
    if (event.kind === 'transfer') {
      if (event.type === 'upload-progress') {
        if (uploadBusyRef.current) setUploadProgress(current => {
          const now = Date.now();
          return { ...current, ...event, phase: event.phase || 'preparing', updatedAt: now,
            startedAt: current?.startedAt ?? now,
            transferStartedAt: current?.transferStartedAt ?? (event.phase === 'uploading' ? now : undefined) };
        });
      } else setTransfer(event);
      return;
    }
    if (event.kind === 'terminal' && event.jobId === terminalRef.current) {
      if (event.type === 'data' || event.type === 'error') setTerminalOutput(s => cleanTerminalOutput(s + (event.data || '')).slice(-180000));
      if (event.type === 'exit') { setTerminalOutput(s => `${s}\n[${event.signal === 'STOP_UNCONFIRMED' ? '停止状态尚未确认，请检查远端进程' : event.stopped ? '已请求停止' : `进程退出 · ${event.code ?? event.signal ?? '未知状态'}`}]\n`); terminalRef.current = null; setTerminalJob(null); }
      return;
    }
    const run = runRef.current;
    if (event.kind !== 'chat' || !run || event.jobId !== run.id) return;
    if (event.type === 'error') { updateAssistant(run, m => ({ ...m, content: `${m.content}\n\n${event.data || '请求失败'}`, error: true })); }
    if (event.type === 'stderr' && event.data) { setTerminalOutput(s => cleanTerminalOutput(`${s}[Claude] ${event.data}`).slice(-180000)); }
    if (event.type === 'exit') {
      if (notifications && !run.persistent && !event.stopped) void api.notifyTask({ jobId: run.id, state: event.code === 0 && run.hasResult ? 'completed' : 'failed', title: stateRef.current.conversations.find(c => c.id === run.conversationId)?.title || 'Claude 任务', conversationId: run.conversationId }).catch(() => {});
      setUsageRevision(value => value + 1);
      if (!run.hasResult && !event.stopped) updateAssistant(run, m => ({ ...m, content: `${m.content}\n\n${event.code === 0 ? '本次请求结束，未收到完整结果。可查看终端日志。' : `Claude 进程退出（${event.code ?? event.signal ?? '未知状态'}）。请查看终端日志。`}`, error: true }));
      if (event.stopped) updateAssistant(run, m => ({ ...m, content: `${m.content}\n\n${event.signal === 'STOP_UNCONFIRMED' ? '停止状态尚未确认，请重连后检查远端任务。' : '已请求停止本次任务。'}` }));
      runRef.current = null; setChatRun(null); setTaskStatus(event.stopped ? event.signal === 'STOP_UNCONFIRMED' ? '停止状态待确认' : '任务已结束' : event.code === 0 ? '就绪' : '请求结束');
      return;
    }
    if (event.type !== 'event' || !event.event) return;
    const raw = event.event;
    if (raw.parent_tool_use_id) return;
    if (raw.session_id) updateAssistant(run, m => m, String(raw.session_id));
    if (raw.type === 'stream_event' && raw.event?.type === 'content_block_delta' && raw.event.delta?.type === 'text_delta') {
      run.pending += raw.event.delta.text || '';
      updateAssistant(run, m => ({ ...m, content: [run.confirmed, run.pending].filter(Boolean).join('\n\n') }));
    }
    if (raw.type === 'assistant' && Array.isArray(raw.message?.content)) {
      const messageKey = String(raw.uuid || raw.message.id || JSON.stringify(raw.message.content));
      if (run.seen.has(messageKey)) return;
      run.seen.add(messageKey);
      const blocks = raw.message.content as Array<Record<string, any>>;
      const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('\n');
      if (text) { run.confirmed = [run.confirmed, text].filter(Boolean).join('\n\n'); run.pending = ''; }
      const tools = blocks.filter(b => b.type === 'tool_use').map(b => ({ id: String(b.id), name: String(b.name), input: b.input }));
      const files = blocks.filter(b => b.type === 'tool_use' && ['Write', 'Edit', 'NotebookEdit'].includes(b.name)).map(b => b.input?.file_path || b.input?.notebook_path).filter((p): p is string => typeof p === 'string');
      if (tools.length) setTaskStatus(`正在${tools[tools.length - 1].name === 'Read' ? '读取文件' : tools[tools.length - 1].name === 'Bash' ? '运行命令' : '处理项目'}`);
      updateAssistant(run, m => ({ ...m, content: [run.confirmed, run.pending].filter(Boolean).join('\n\n'), tools: [...(m.tools || []), ...tools.filter(t => !m.tools?.some(old => old.id === t.id))], files: [...new Set([...(m.files || []), ...files])] }));
    }
    if (raw.type === 'user' && Array.isArray(raw.message?.content)) {
      for (const result of raw.message.content) if (result.type === 'tool_result') {
        const text = typeof result.content === 'string' ? result.content : JSON.stringify(result.content);
        updateAssistant(run, m => ({ ...m, tools: m.tools?.map(t => t.id === result.tool_use_id ? { ...t, result: text?.slice(0, 14000) || '完成' } : t) }));
      }
    }
    if (raw.type === 'result') {
      run.hasResult = true;
      updateAssistant(run, m => ({ ...m, content: m.content || raw.result || (raw.errors ? raw.errors.join('\n') : '本次任务已结束。'), error: !!raw.is_error }));
      if (raw.permission_denials?.length) updateAssistant(run, m => ({ ...m, content: `${m.content}\n\n有 ${raw.permission_denials.length} 项操作未获得权限。你可以在终端手动执行所需命令，或调整下次任务的权限。` }));
      setTaskStatus(raw.is_error ? '请求失败' : '已完成');
      setFilesRevision(r => r + 1);
    }
    if (raw.type === 'system' && raw.subtype === 'api_retry') setTaskStatus(`服务重试中 · ${raw.attempt || 1}`);
  }; chatEvent.current = handler; return api.onEvent(handler); }, [notify, updateAssistant, notifications]);

  const attachTask = (task: RemoteTask) => {
    if (runRef.current && runRef.current.id !== task.jobId) { notify('请先停止当前任务或断开连接，再接回其他任务', true); return; }
    const targetProject = stateRef.current.projects.find(p => p.path === task.projectPath && p.connectionKey === configKey(stateRef.current.connection));
    if (!targetProject) { notify('请先打开此任务的项目', true); return; }
    if (runRef.current?.id === task.jobId) { setActiveProjectId(targetProject.id); setActiveConversationId(runRef.current.conversationId); return; }
    const existing = stateRef.current.conversations.find(c => c.id === task.conversationId || c.task?.jobId === task.jobId);
    const target: Conversation = existing || { id: task.conversationId || id(), projectId: targetProject.id, title: task.title || '恢复的任务', updatedAt: Date.now(), messages: [] };
    const messageId = target.messages.find(m => m.jobId === task.jobId)?.id || (target.task?.jobId === task.jobId ? target.task.messageId : id());
    const messages = target.messages.some(m => m.id === messageId) ? target.messages.map(m => m.id === messageId ? { ...m, content: '', tools: [], files: [], error: false } : m) : [...target.messages, { id: messageId, role: 'assistant' as const, content: '' }];
    const next = { ...target, messages: messages.map(m => m.id === messageId ? { ...m, jobId: task.jobId } : m), task: { jobId: task.jobId, messageId, cursor: 0, finished: false }, sessionId: task.sessionId || target.sessionId };
    setState(s => ({ ...s, conversations: existing ? s.conversations.map(c => c.id === target.id ? next : c) : [...s.conversations, next] }));
    setActiveProjectId(targetProject.id); setActiveConversationId(target.id);
    const run: ChatRun = { id: task.jobId, conversationId: target.id, messageId, confirmed: '', pending: '', seen: new Set(), hasResult: false, persistent: true, projectPath: task.projectPath };
    runRef.current = run; setChatRun(run); setActiveTask(task); setPersistentReady(task.jobId); setTaskPollError('');
  };
  useEffect(() => {
    if (!connected || !persistentReady || !runRef.current?.persistent) return;
    const run = runRef.current; let canceled = false; let cursor = 0; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await api.pollTask({ projectPath: run.projectPath!, jobId: run.id, cursor });
        if (canceled || runRef.current !== run) return;
        cursor = result.cursor; setTaskPollError(''); setActiveTask(result.task);
        for (const event of result.events) chatEvent.current({ kind: 'chat', jobId: run.id, conversationId: run.conversationId, ...event });
        setState(s => { const target = s.conversations.find(c => c.id === run.conversationId); if (target?.task?.cursor === cursor && (!result.task.sessionId || target.sessionId === result.task.sessionId)) return s; return { ...s, conversations: s.conversations.map(c => c.id === run.conversationId ? { ...c, sessionId: result.task.sessionId || c.sessionId, task: { jobId: run.id, messageId: run.messageId, cursor } } : c) }; });
        if (result.task.state === 'waiting') {
          setTaskStatus('等待你的回答');
          if (notificationsRef.current) for (const request of result.task.pendingRequests) void api.notifyTask({ jobId: run.id, state: 'waiting', requestId: request.request_id, title: result.task.title, conversationId: run.conversationId }).catch(() => {});
        }
        if (!result.more && ['completed', 'failed', 'stopped', 'interrupted'].includes(result.task.state)) {
          const failed = ['failed', 'interrupted'].includes(result.task.state);
          if (result.task.message && (failed || !run.hasResult)) updateAssistant(run, m => ({ ...m, content: `${m.content}\n\n${result.task.message}`, error: failed }));
          if (notificationsRef.current && result.task.state !== 'stopped') void api.notifyTask({ jobId: run.id, state: failed ? 'failed' : 'completed', title: result.task.title, conversationId: run.conversationId }).catch(() => {});
          setState(s => ({ ...s, conversations: s.conversations.map(c => c.id === run.conversationId ? { ...c, task: { jobId: run.id, messageId: run.messageId, cursor, finished: true } } : c) }));
          chatEvent.current({ kind: 'chat', jobId: run.id, type: 'exit', code: failed ? 1 : 0, stopped: result.task.state === 'stopped' });
          setPersistentReady(''); setActiveTask(null); return;
        }
        timer = setTimeout(poll, result.more ? 30 : 1500);
      } catch (error) { if (!canceled) { setTaskPollError(`任务状态暂时无法读取：${errorText(error)}`); timer = setTimeout(poll, 5000); } }
    };
    void poll(); return () => { canceled = true; clearTimeout(timer); };
  }, [connected, persistentReady]);
  useEffect(() => {
    if (!connected || runRef.current) return;
    const existing = stateRef.current.conversations.find(c => c.id === activeConversationId && c.task && !c.task.finished);
    const targetProject = stateRef.current.projects.find(p => p.id === existing?.projectId && p.connectionKey === configKey(stateRef.current.connection));
    if (!existing?.task || !targetProject) return;
    let canceled = false;
    void api.pollTask({ projectPath: targetProject.path, jobId: existing.task.jobId, cursor: 0 }).then(result => { if (!canceled && !runRef.current) attachTask(result.task); }).catch(e => { if (!canceled) setTaskPollError(errorText(e)); });
    return () => { canceled = true; };
  }, [connected, connectionGeneration, activeConversationId]);
  const addAttachments = async (action: () => Promise<Attachment[]>) => {
    if (attachmentBusyRef.current) return;
    const origin = uploadContextRef.current;
    attachmentBusyRef.current = true; setAttachmentBusy(true);
    try {
      const items = await action();
      const current = uploadContextRef.current;
      if (origin.projectId !== current.projectId || origin.conversationId !== current.conversationId || origin.generation !== current.generation) { await api.discardAttachments({ ids: items.map(a => a.id) }); return; }
      const slots = Math.max(0, 32 - attachmentsRef.current.length);
      if (items.length > slots) { void api.discardAttachments({ ids: items.slice(slots).map(a => a.id) }); notify('每条消息最多添加 32 个附件'); }
      setAttachments(old => [...old, ...items.slice(0, slots)]);
      if (!items.length) notify('剪贴板中没有图片或文件，文字可直接粘贴');
    } catch (error) { notify(errorText(error), true); }
    finally { attachmentBusyRef.current = false; setAttachmentBusy(false); }
  };
  const attachmentsRef = useRef(attachments); attachmentsRef.current = attachments;
  useEffect(() => { const old = attachmentsRef.current; setAttachments([]); if (old.length) void api.discardAttachments({ ids: old.map(a => a.id) }).catch(() => {}); setImagePath(''); setInteractiveTerminal(null); }, [activeProjectId, activeConversationId, connectionGeneration]);
  const removeAttachment = (item: Attachment) => { setAttachments(old => old.filter(a => a.id !== item.id)); void api.discardAttachments({ ids: [item.id] }).catch(() => {}); };
  const addSelection = (text: string) => { setPrompt(old => `${old}${old ? '\n\n' : ''}${text}`); composerRef.current?.focus(); };
  const downloadBundle = async (path: string) => { try { const result = await api.downloadBundle({ path }); if (!result.canceled) notify(`已下载 ZIP，包含 ${result.files} 个文件`); } catch (e) { notify(errorText(e), true); } };

  const refreshFiles = useCallback(async (path?: string) => {
    const target = path || directory || project?.path;
    if (!target || !connectionRef.current) return;
    setFilesLoading(true); setFileError('');
    try { const result = await api.listFiles({ path: target }); setFiles(result); setDirectory(target); }
    catch (error) { setFileError(errorText(error)); }
    finally { setFilesLoading(false); }
  }, [directory, project?.path]);
  useEffect(() => { setFiles([]); setOpenFile(null); setDiff(null); setDirectory(project?.path || ''); }, [activeProjectId]);
  useEffect(() => { if (connected && project) void refreshFiles(project.path); }, [activeProjectId, connected, filesRevision]);
  const loadDiff = async () => {
    if (!project || !connected) return;
    setDiffLoading(true);
    try { setDiff(await api.getDiff({ projectPath: project.path })); } catch (error) { notify(errorText(error), true); }
    finally { setDiffLoading(false); }
  };
  const canDiscard = () => !dirty || window.confirm('当前文件有未保存的修改。确定放弃这些修改？');
  const selectProject = (item: Project) => { if (!canDiscard()) return; setActiveProjectId(item.id); setActiveConversationId(state.conversations.filter(c => c.projectId === item.id).sort((a, b) => b.updatedAt - a.updatedAt)[0]?.id || ''); setReferences([]); projectHistory.refresh(); };
  const newConversation = () => { if (!project) { connected ? openProjectModal() : openConnection(); return; } const next: Conversation = { id: id(), projectId: project.id, title: '新对话', messages: [], updatedAt: Date.now() }; setState(s => ({ ...s, conversations: [...s.conversations, next] })); setActiveConversationId(next.id); setPrompt(''); setReferences([]); composerRef.current?.focus(); };
  const openConnection = () => { setDraftConnection({ ...state.connection, password: '', passphrase: '' }); setConnectionError(''); setConnectionModal(true); };
  const openProjectModal = () => { if (!connected) { openConnection(); return; } setProjectName(''); setProjectPath(`${connection!.workspace}/`); setProjectMode('create'); setProjectModal(true); };
  const openExistingProject = () => {
    if (!connected) { openConnection(); return; }
    setProjectName(''); setProjectPath(`${connection!.workspace}/`); setProjectMode('open'); setProjectModal(true);
  };
  const connectWithConfig = async (config: ConnectionConfig, automatic = false) => {
    if (connectingRef.current) return;
    connectingRef.current = true;
    setConnectionError(''); setConnecting(true); setTaskStatus(automatic ? '正在自动连接设备…' : '正在连接设备…');
    const previous = stateRef.current;
    try {
      if (connectionRef.current) await api.disconnect();
      const result = await api.connect(config);
      setConnectionGeneration(value => value + 1);
      const savedConfig = { ...stripSecrets(config), credentialSaved: result.credentialSaved ?? false };
      setConnection(result); setState(s => ({ ...s, connection: savedConfig })); setDraftConnection(savedConfig);
      if (configKey(config) !== configKey(previous.connection)) { setOpenFile(null); setActiveProjectId(''); setActiveConversationId(''); setFiles([]); setDirectory(''); setReferences([]); }
      setConnectionModal(false); setTaskStatus('就绪'); notify(result.warning || (result.claudeAvailable ? `已连接 ${result.hostname}` : 'SSH 已连接，但未找到 Claude Code。请检查 Claude 命令路径。'), !!result.warning || !result.claudeAvailable);
      if (!previous.projects.some(p => p.connectionKey === configKey(config))) { setProjectPath(`${result.workspace}/`); setProjectName(''); setProjectMode('create'); setProjectModal(true); }
    } catch (error) {
      const message = `${automatic ? '自动连接未完成：' : ''}${errorText(error)}`;
      setConnectionError(message); setTaskStatus(automatic ? '自动连接未完成' : '连接未完成');
      if (automatic) { setDraftConnection(stripSecrets(config)); setConnectionModal(true); }
    } finally { connectingRef.current = false; setConnecting(false); }
  };
  useEffect(() => {
    if (!loaded || startupAttemptedRef.current) return;
    startupAttemptedRef.current = true;
    const config = state.connection;
    const configured = config.host.trim() && config.username.trim() && (config.authType !== 'key' || config.privateKeyPath?.trim());
    if (isDesktop && config.autoConnect !== false && configured) void connectWithConfig(config, true);
  }, [loaded, state.connection]);
  const connect = async (event: FormEvent) => {
    event.preventDefault();
    if (connectingRef.current || configSaving || !canDiscard()) return;
    await connectWithConfig(draftConnection);
  };
  const saveConnectionSettings = async () => {
    if (!canSaveConnectionSettings) return;
    setConfigSaving(true); setConnectionError('');
    const config = { ...stripSecrets(draftConnection), credentialSaved: draftConnection.autoConnect !== false && savedCredentialMatches };
    try {
      await api.saveState({ ...stateRef.current, connection: config, settings: { ...stateRef.current.settings, activeProjectId, activeConversationId, panelWidth, allowCommands } });
      setState(s => ({ ...s, connection: config })); setDraftConnection(config); setConnectionModal(false);
      notify(config.autoConnect !== false ? '已保存：下次启动时自动连接' : '已关闭自动连接，并清除保存的登录凭据');
    } catch (error) { setConnectionError(errorText(error)); }
    finally { setConfigSaving(false); }
  };
  const disconnect = async () => {
    if ((chatRun && !runRef.current?.persistent || terminalJob || interactiveTerminal) && !window.confirm('断开将结束交互终端和普通任务。已开启断线续跑的任务会保留在远端。继续断开？')) return;
    try { await api.disconnect(); setConnection(null); setTaskStatus('未连接'); } catch (error) { notify(errorText(error), true); }
  };
  const addProject = async (event: FormEvent) => {
    event.preventDefault(); if (projectBusy) return;
    const name = projectName.trim(); const path = projectPath.trim().replace(/\/$/, '');
    if (!name || !path) return;
    setProjectBusy(true);
    try {
      let finalPath = path;
      if (projectMode === 'create') finalPath = (await api.mkdir({ path })).path;
      else finalPath = (await api.openProject({ path })).path;
      const existing = visibleProjects.find(p => p.path === finalPath);
      if (!canDiscard()) return;
      const next = existing || { id: id(), name, path: finalPath, connectionKey: configKey(state.connection) };
      if (!existing) setState(s => ({ ...s, projects: [...s.projects, next] }));
      setActiveProjectId(next.id); setActiveConversationId(''); setProjectModal(false); notify(projectMode === 'create' ? '项目文件夹已创建' : '已打开项目');
      projectHistory.refresh();
    } catch (error) { notify(errorText(error), true); } finally { setProjectBusy(false); }
  };
  const openRemoteFile = async (path: string) => {
    if (!connected || !canDiscard()) return;
    if (isImagePath(path)) { setImagePath(path); return; }
    if (/\.(pdf|docx|xlsx|pptx|mp4|webm|mp3|wav)$/i.test(path)) { try { await api.openLocalFile({ path }); } catch (e) { notify(errorText(e), true); } return; }
    setFileBusy(true); setPanelOpen(true);
    try { const result = await api.readFile({ path }); setOpenFile({ path, ...result, original: result.content }); setTab('code'); }
    catch (error) { notify(errorText(error), true); } finally { setFileBusy(false); }
  };
  const saveFile = async () => {
    if (!openFile || !dirty || fileBusy || !connected) return;
    const current = openFile;
    setFileBusy(true);
    try { const result = await api.saveFile({ path: current.path, content: current.content, expectedMtime: current.mtime }); setOpenFile(file => file?.path === current.path ? { ...file, original: current.content, ...result } : file); notify('文件已保存'); }
    catch (error) { notify(errorText(error), true); } finally { setFileBusy(false); }
  };
  useEffect(() => { const listener = (event: KeyboardEvent) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void saveFile(); } }; window.addEventListener('keydown', listener); return () => window.removeEventListener('keydown', listener); }, [openFile, dirty, fileBusy, connected]);
  const download = async (path: string) => {
    if (!connected) { notify('请先连接设备', true); return; }
    try { const result = await api.download({ path }); if (!result.canceled) notify(`已下载 ${baseName(path)} 到 Windows`, false, result.localPath); }
    catch (error) { notify(`下载失败：${errorText(error)}`, true); } finally { setTransfer(null); }
  };
  const upload = async (attach = false, kind: 'files' | 'folder' = 'files') => {
    if (!project || !connected || uploadBusyRef.current) return;
    uploadBusyRef.current = true;
    setUploadBusy(kind);
    const uploadStartedAt = Date.now();
    setUploadProgress({ phase: 'selecting', updatedAt: uploadStartedAt, startedAt: uploadStartedAt });
    setPanelOpen(true); setTab('files');
    const origin = uploadContextRef.current;
    const destination = attach ? project.path : directory || project.path;
    const sameProject = () => {
      const current = uploadContextRef.current;
      return current.connection !== null && current.connection === origin.connection && current.generation === origin.generation && current.projectId === origin.projectId;
    };
    let shouldRefresh = true;
    try {
      const result = await api.upload({ directory: destination, kind });
      if (result.canceled) {
        shouldRefresh = false;
        return;
      }
      const count = result.files?.length || 0;
      notify(kind === 'folder' ? `已上传 ${result.folders?.length || 0} 个文件夹（${count} 个文件）` : `已上传 ${count} 个文件`);
      if (attach && sameProject() && uploadContextRef.current.conversationId === origin.conversationId) {
        const paths = kind === 'folder' ? result.folders || [] : result.files || [];
        if (kind === 'folder') paths.forEach(path => folderReferencePaths.current.add(path));
        setReferences(current => [...new Set([...current, ...paths])]);
      }
    } catch (error) {
      notify(`上传失败：${errorText(error)}`, true);
    } finally {
      uploadBusyRef.current = false;
      setUploadBusy(null);
      setUploadProgress(null);
      setTransfer(current => current?.direction === 'upload' ? null : current);
      // A failed recursive upload may have already created some remote files.
      if (shouldRefresh && sameProject()) void refreshFiles(uploadContextRef.current.directory || project.path);
    }
  };
  const createFile = async (event: FormEvent) => {
    event.preventDefault(); if (!newFileName.trim() || /[\\/]/.test(newFileName) || !canDiscard()) return;
    const path = `${directory || project?.path}/${newFileName.trim()}`;
    if (files.some(f => f.path === path)) { notify('同名文件已存在，请使用其他名称', true); return; }
    setFileBusy(true);
    try { await api.saveFile({ path, content: '', expectedMtime: null }); setNewFileModal(false); void refreshFiles(); await openRemoteFile(path); } catch (error) { notify(errorText(error), true); } finally { setFileBusy(false); }
  };
  const send = async () => {
    if ((!prompt.trim() && !attachments.length && !references.length) || runRef.current || attachmentBusyRef.current || uploadBusyRef.current) return;
    const localCommand = localChatCommand(prompt);
    if (localCommand) {
      const remainingDraft = prompt.trimStart().replace(/^\/\S*\s*/, '');
      chatCompletion.close(); setPrompt('');
      if (localCommand === 'help') setCommandHelpModal(true);
      if (localCommand === 'clear') newConversation();
      if (localCommand === 'usage') { setSidebarOpen(true); setUsageRevealRevision(value => value + 1); setUsageRevision(value => value + 1); }
      if (localCommand === 'permissions') setPermissionModal(true);
      setPrompt(remainingDraft);
      return;
    }
    if (!connection) { openConnection(); return; }
    if (!project) { openProjectModal(); return; }
    if (conversation?.historyLoaded === false) { notify('请等历史对话加载完成后再继续；加载失败时可点击重试。', true); return; }
    if (!connection.claudeAvailable) { notify('未找到 Claude Code，请在连接设置中检查命令路径', true); return; }
    let uploaded: Attachment[] = [];
    const origin = uploadContextRef.current;
    if (attachments.length) {
      attachmentBusyRef.current = true; setAttachmentBusy(true);
      try {
        uploaded = await api.uploadAttachments({ ids: attachments.map(a => a.id), projectPath: project.path });
        const current = uploadContextRef.current;
        if (origin.projectId !== current.projectId || origin.conversationId !== current.conversationId || origin.generation !== current.generation) throw new Error('当前会话已变化，附件已上传，请在原项目中重新引用');
      } catch (e) { notify(`附件未发送：${errorText(e)}`, true); return; }
      finally { attachmentBusyRef.current = false; setAttachmentBusy(false); }
    }
    let target = conversation;
    if (!target || target.projectId !== project.id) target = { id: id(), projectId: project.id, title: '新对话', messages: [], updatedAt: Date.now() };
    const text = prompt.trim() || '请查看这些附件。'; const allReferences = [...references, ...uploaded.map(a => a.path!)];
    const fullPrompt = allReferences.length ? `${text}\n\n请读取以下参考项目文件（图片请使用 Read 工具查看图像内容）：\n${allReferences.map(p => `- ${p}`).join('\n')}` : text;
    const userMessage: Message = { id: id(), role: 'user', content: text, attachments: uploaded, files: references };
    const assistantMessage: Message = { id: id(), role: 'assistant', content: '' };
    const finalConversation: Conversation = { ...target, title: target.messages.length ? target.title : text.slice(0, 24), updatedAt: Date.now(), messages: [...target.messages, userMessage, assistantMessage] };
    setState(s => ({ ...s, conversations: s.conversations.some(c => c.id === target!.id) ? s.conversations.map(c => c.id === target!.id ? finalConversation : c) : [...s.conversations, finalConversation] }));
    setActiveConversationId(target.id); setPrompt(''); setReferences([]); setAttachments([]);
    void api.discardAttachments({ ids: uploaded.map(a => a.id) }).catch(() => {});
    const run: ChatRun = { id: id(), conversationId: target.id, messageId: assistantMessage.id, confirmed: '', pending: '', seen: new Set(), hasResult: false, persistent: durableTasks, projectPath: project.path };
    runRef.current = run; setChatRun(run); setTaskStatus('正在连接 Claude');
    try {
      const options = { jobId: run.id, conversationId: target.id, projectPath: project.path, prompt: fullPrompt, sessionId: target.sessionId, mode, allowCommands: mode === 'edit' && allowCommands };
      if (durableTasks) {
        setState(s => ({ ...s, conversations: s.conversations.map(c => c.id === target!.id ? { ...c, messages: c.messages.map(m => m.id === run.messageId ? { ...m, jobId: run.id } : m), task: { jobId: run.id, messageId: run.messageId, cursor: 0 } } : c) }));
        await api.startPersistentChat({ ...options, askCommands: mode === 'edit' && askCommands }); setPersistentReady(run.id);
      } else await api.startChat(options);
    }
    catch (error) { updateAssistant(run, m => ({ ...m, content: errorText(error), error: true })); runRef.current = null; setChatRun(null); setTaskStatus('请求失败'); }
  };
  const stop = async (jobId: string) => { try { if (runRef.current?.id === jobId && runRef.current.persistent) await api.stopTask({ projectPath: runRef.current.projectPath!, jobId }); else await api.stopJob({ jobId }); notify('已发送停止请求，等待远端确认'); } catch (error) { notify(errorText(error), true); } };
  const runCommand = async (command: string) => {
    if (!command.trim() || !project || !connected) return;
    setTerminalOpen(true);
    if (terminalRef.current) { await api.writeJob({ jobId: terminalRef.current, data: `${command}\n` }).catch(error => notify(errorText(error), true)); setTerminalCommand(''); return; }
    const jobId = id(); terminalRef.current = jobId; setTerminalJob(jobId); setTerminalCommand('');
    setTerminalOutput(s => `${s}${s ? '\n' : ''}${state.connection.username}@${connection!.hostname}:${project.path}$ ${command}\n`);
    try { await api.runCommand({ jobId, projectPath: project.path, command }); }
    catch (error) { setTerminalOutput(s => `${s}${errorText(error)}\n`); terminalRef.current = null; setTerminalJob(null); }
  };
  const runFile = () => {
    if (!openFile || !project) return;
    if (dirty) { notify('请先保存修改，再运行文件', true); return; }
    const path = shellQuote(openFile.path);
    const command = /\.py$/.test(openFile.path) ? `python3 ${path}` : /\.(js|mjs|cjs)$/.test(openFile.path) ? `node ${path}` : /\.sh$/.test(openFile.path) ? `bash ${path}` : '';
    setTerminalOpen(true); setTerminalCommand(command); if (!command) notify('请在终端中输入这个文件的运行命令');
  };
  const resizePanel = (event: React.PointerEvent) => {
    event.preventDefault(); const startX = event.clientX, startWidth = panelWidth;
    const move = (e: PointerEvent) => setPanelWidth(Math.min(Math.max(330, startWidth + startX - e.clientX), Math.min(800, window.innerWidth - 580)));
    const end = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', end); document.body.style.cursor = ''; };
    document.body.style.cursor = 'col-resize'; window.addEventListener('pointermove', move); window.addEventListener('pointerup', end);
  };
  const language = openFile?.path.endsWith('.py') ? python() : /\.(js|ts|jsx|tsx)$/.test(openFile?.path || '') ? javascript({ typescript: /\.tsx?$/.test(openFile?.path || ''), jsx: /\.[jt]sx$/.test(openFile?.path || '') }) : openFile?.path.endsWith('.json') ? json() : [];

  return <div className={`app-shell ${!sidebarOpen ? 'sidebar-collapsed' : ''}`}>
    <aside className="sidebar">
      <div className="brand"><Star size={30} /><span>Cloude</span><IconButton label="收起侧栏" onClick={() => setSidebarOpen(false)}><PanelLeftClose size={16} /></IconButton></div>
      <button className="new-chat" onClick={newConversation}><Plus size={17} />新对话</button>
      <div className="sidebar-section-title"><span>项目</span><div className="project-actions"><IconButton label="读取已有项目" onClick={openExistingProject}><FolderOpen size={15} /></IconButton><IconButton label="添加项目" onClick={openProjectModal}><Plus size={15} /></IconButton></div></div>
      <div className="project-list">{visibleProjects.map(item => <button className={`project-item ${item.id === activeProjectId ? 'selected' : ''}`} key={item.id} onClick={() => selectProject(item)} title={item.path}><Folder size={16} /><span>{item.name}</span>{item.id === activeProjectId && <ChevronDown size={14} />}</button>)}{!visibleProjects.length && <button className="empty-project" onClick={openProjectModal}><FolderPlus size={19} /><span>打开你的第一个项目</span></button>}</div>
      <div className="sidebar-section-title conversation-title"><span>最近对话</span><div className="project-actions"><span className="count">{conversations.length || ''}</span><IconButton label="刷新历史对话" disabled={!connected || !project || projectHistory.loading} onClick={projectHistory.refresh}>{projectHistory.loading ? <Spinner /> : <RefreshCw size={13} />}</IconButton></div></div>
      <nav className="conversation-list" aria-label="聊天记录">{conversations.map(item => <button className={`conversation-item ${item.id === activeConversationId ? 'selected' : ''}`} key={item.id} data-session-id={item.sessionId} title={item.title} onClick={() => setActiveConversationId(item.id)}><MessageSquare size={14} /><span>{item.title}</span>{chatRun?.conversationId === item.id && <span className="small-pulse" />}</button>)}{!conversations.length && !projectHistory.loading && !projectHistory.error && <p className="sidebar-hint">{connected ? '这个项目暂无对话' : '连接设备后自动读取历史对话'}</p>}
        {projectHistory.loading && <p className="history-sync-status" role="status"><Spinner />正在读取历史对话…</p>}
        {projectHistory.error && <div className="history-sync-status error" role="alert"><span>历史对话读取失败：{projectHistory.error}</span><button className="text-button" onClick={projectHistory.refresh}>重试</button></div>}
        {projectHistory.warning && <p className="history-sync-status">{projectHistory.warning}</p>}
      </nav>
      <div className="sidebar-bottom"><UsagePanel connectionKey={connected ? `${configKey(state.connection)}:${connectionGeneration}` : null} refreshToken={usageRevision} visible={sidebarOpen} revealToken={usageRevealRevision} /><div className="device-card"><div className="device-icon"><HardDrive size={20} /></div><div className="device-copy"><strong>{state.connection.host || '远程设备'}</strong><span><i className={`status-dot ${connected ? 'online' : ''}`} />{connected ? `${state.connection.username} · SSH 已连接` : '设备未连接'}</span></div><IconButton label="设备连接设置" onClick={openConnection}><Settings2 size={16} /></IconButton></div><button className="sidebar-settings" onClick={openConnection}><Settings2 size={16} />连接设置<span>SSH</span></button><UpdateControl blocked={dirty || !!chatRun || !!terminalJob || !!uploadBusy || fileBusy || connecting || projectBusy || projectHistory.loading || conversation?.historyLoaded === false} /></div>
    </aside>

    <main className="main-area">
      <header className="topbar"><div className="topbar-left">{!sidebarOpen && <IconButton label="展开侧栏" onClick={() => setSidebarOpen(true)}><PanelLeftClose size={18} /></IconButton>}<span className="breadcrumb-root">工作台</span><ChevronRight size={14} /><span className="breadcrumb-project">{project?.name || '开始一个项目'}</span>{connected && <span className="remote-pill"><Wifi size={12} />远程</span>}</div><div className="topbar-right">{!isDesktop && <span className="preview-badge">界面预览 · 未连接设备</span>}<button className={`connection-button ${connected ? 'connected' : ''}`} onClick={openConnection}>{connecting ? <Spinner /> : connected ? <Wifi size={14} /> : <WifiOff size={14} />}{connecting ? '正在连接…' : connected ? '已连接' : '连接设备'}</button><span className="topbar-divider" /><div className="feature-toolbar"><IconButton label="远端网页与端口" disabled={!connected} onClick={() => setPortsOpen(true)}><Globe size={16} /></IconButton><IconButton label="远端任务与恢复" disabled={!connected || !project} onClick={() => setTasksOpen(true)}><ListTodo size={16} /></IconButton><IconButton label="打开交互终端" disabled={!connected || !project} onClick={() => { setPanelOpen(true); setInteractiveTerminal("shell"); }}><Terminal size={16} /></IconButton><IconButton label="登录远端 Claude" disabled={!connected || !project} onClick={() => { setPanelOpen(true); setInteractiveTerminal("login"); }}><LogIn size={16} /></IconButton></div><IconButton label={panelOpen ? '收起工作区' : '展开工作区'} onClick={() => setPanelOpen(!panelOpen)}>{panelOpen ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}</IconButton></div></header>
      <div className="workspace-body">
        <section className="chat-panel" aria-label="Claude 聊天">
          {conversation && (conversation.messages.length > 0 || conversation.sessionId) ? <div className="chat-scroll"><div className="conversation-heading"><span>{conversation.title}</span><span>{conversation.sessionId ? '上下文已关联' : '新会话'}</span></div>{conversation.historyNotice && <p className="history-notice">{conversation.historyNotice}</p>}{conversation.historyLoaded === false ? <div className="history-notice history-load-status" role={projectHistory.readError ? 'alert' : 'status'}>{projectHistory.readError ? <><span>历史对话加载失败：{projectHistory.readError}</span><button className="text-button" onClick={projectHistory.refresh}>重试</button></> : connected ? <><Spinner />正在加载历史对话…</> : '连接设备后可读取这份历史对话。'}</div> : !conversation.messages.length && <p className="history-notice">这份会话暂时没有可显示的文字消息，可以直接发送消息继续。</p>}<div className="messages">{conversation.messages.map(message => <MessageView key={message.id} message={message} streaming={chatRun?.messageId === message.id} onDownload={download} onOpen={openRemoteFile} projectPath={project?.path} connected={connected} />)}<div ref={chatBottom} /></div></div> : <div className="welcome"><div className="welcome-inner"><Star size={58} /><p className="welcome-eyebrow">你的远程开发空间</p><h1>今天，<br />一起完成什么？</h1><div className="suggestions"><button onClick={() => { setPrompt('请先阅读这个项目，介绍代码结构和主要入口。'); composerRef.current?.focus(); }}><Code2 size={17} /><span>了解这个项目</span><ArrowUp size={14} /></button><button onClick={() => { setPrompt('帮我检查项目中的问题，并给出修改建议。'); composerRef.current?.focus(); }}><GitCompareArrows size={17} /><span>检查与改进代码</span><ArrowUp size={14} /></button></div>{!connected && <button className="welcome-connect" onClick={openConnection}><span className="status-dot" />连接设备，开始工作<ChevronRight size={14} /></button>}</div></div>}
          {taskPollError && <p className="task-poll-error">{taskPollError}</p>}{activeTask && connected && chatRun?.conversationId === activeConversationId && activeTask.pendingRequests.map(request => <RequestCard key={request.request_id} request={request} task={activeTask} onDone={() => setActiveTask(old => old ? { ...old, pendingRequests: old.pendingRequests.filter(r => r.request_id !== request.request_id) } : old)} />)}<div className="composer-area"><CommandSuggestions controller={chatCompletion} label="Claude 常用命令" className="chat-command-menu" /><div className={`composer ${dropActive ? "drop-active" : ""}`} onDragOver={e => { e.preventDefault(); setDropActive(true); }} onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropActive(false); }} onDrop={e => { e.preventDefault(); setDropActive(false); const items = Array.from(e.dataTransfer.files); if (items.length) void addAttachments(() => api.stageDropped(items)); }}>
            {attachments.length > 0 && <div className="attachment-strip">{attachments.map(item => <div className="attachment-chip" key={item.id}>{item.preview ? <img src={item.preview} alt={item.name} /> : <FileIcon name={item.name} directory={item.kind === "folder"} />}<span title={item.name}>{item.name}</span><button aria-label={`移除附件 ${item.name}`} disabled={attachmentBusy} onClick={() => removeAttachment(item)}><X size={13} /></button></div>)}</div>}{attachmentBusy && <div className="paste-status"><Spinner /> 正在准备附件…</div>}{references.length > 0 && <div className="references">{references.map(path => <span key={path} title={path}><FileIcon name={path} directory={folderReferencePaths.current.has(path)} />{baseName(path)}<button aria-label={`移除引用 ${baseName(path)}`} onClick={() => setReferences(r => r.filter(p => p !== path))}><X size={12} /></button></span>)}</div>}
            <textarea ref={composerRef} value={prompt} onPaste={e => { const files = Array.from(e.clipboardData.files); if (files.length) { e.preventDefault(); void addAttachments(() => api.stageDropped(files)); } else if (e.clipboardData.types.includes("Files")) { e.preventDefault(); void addAttachments(() => api.stageClipboard()); } }} onChange={e => { const value = e.target.value; if (/(?:^|\s)@$/.test(value) && connected && project) { setPrompt(value.slice(0, -1)); setFilePicker(true); } else setPrompt(value); }} placeholder={project ? `向 Claude 描述任务，或引用项目文件…` : '从一个想法、一段代码或一个问题开始…'} aria-label="发送给 Claude 的消息" aria-autocomplete="list" aria-controls={chatCompletion.visible ? chatCompletion.listId : undefined} aria-expanded={chatCompletion.visible} aria-activedescendant={chatCompletion.activeDescendant} onBlur={chatCompletion.close} rows={3} onKeyDown={e => { if (isComposingInput(e)) return; if (chatCompletion.handleKeyDown(e)) return; if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); void send(); } }} />
            <div className="composer-toolbar"><div className="composer-tools"><IconButton label="常用 Claude 命令" onClick={chatCompletion.toggle}><span aria-hidden="true">/</span></IconButton><IconButton label="上传文件并引用" disabled={!connected || !project || !!uploadBusy} onClick={() => void upload(true)}>{uploadBusy === 'files' ? <Spinner /> : <Paperclip size={17} />}</IconButton><IconButton label="上传文件夹并引用" disabled={!connected || !project || !!uploadBusy} onClick={() => void upload(true, 'folder')}>{uploadBusy === 'folder' ? <Spinner /> : <FolderUp size={17} />}</IconButton><IconButton label="粘贴图片或文件" disabled={attachmentBusy} onClick={() => void addAttachments(() => api.stageClipboard())}><ClipboardPaste size={16} /></IconButton><IconButton label="搜索并引用项目文件" disabled={!connected || !project} onClick={() => setFilePicker(true)}><Search size={16} /></IconButton><IconButton label="引用当前打开的文件" disabled={!openFile} onClick={() => openFile && setReferences(r => [...new Set([...r, openFile.path])])}><AtSign size={17} /></IconButton><span className="composer-divider" /><select value={mode} aria-label="Claude 工作模式" onChange={e => setMode(e.target.value as 'plan' | 'edit')}><option value="edit">编辑文件</option><option value="plan">只读分析</option></select><button className={`permission-button ${mode === 'edit' && allowCommands ? 'enabled' : ''}`} onClick={() => setPermissionModal(true)} title="Claude 命令执行权限"><ShieldCheck size={14} /><span>{mode === 'plan' ? '只读分析' : allowCommands ? '可运行命令' : durableTasks && askCommands ? '命令执行前询问' : '命令需手动运行'}</span></button></div>{chatRun ? <button className="send-button stop-button" aria-label="停止 Claude 任务" onClick={() => void stop(chatRun.id)}><Square size={16} fill="currentColor" /></button> : <button className="send-button" aria-label="发送消息" disabled={(!prompt.trim() && !attachments.length && !references.length) || attachmentBusy || !!uploadBusy || conversation?.historyLoaded === false} onClick={() => void send()}><ArrowUp size={21} /></button>}</div>
          <div className="composer-feature-options"><label><input type="checkbox" checked={durableTasks} disabled={!!chatRun} onChange={e => setDurableTasks(e.target.checked)} />断线后继续运行</label><label><input type="checkbox" checked={notifications} onChange={e => setNotifications(e.target.checked)} />任务通知</label></div></div><div className="composer-caption"><span>{chatRun ? <><span className="small-pulse" />{taskStatus}</> : null}</span><span>Ctrl + Enter 发送</span></div></div>
        </section>

        {panelOpen && <><div className="resize-handle" onPointerDown={resizePanel} role="separator" aria-label="调整工作区宽度" aria-orientation="vertical" /><section className="workbench" style={{ width: panelWidth }} aria-label="远程文件与代码"><div className="workbench-tabs"><div role="tablist" aria-label="工作区面板"><button role="tab" aria-selected={tab === 'files'} className={tab === 'files' ? 'active' : ''} onClick={() => setTab('files')}><FolderOpen size={15} />文件</button><button role="tab" aria-selected={tab === 'code'} className={tab === 'code' ? 'active' : ''} onClick={() => setTab('code')}><Code2 size={15} />代码{dirty && <span className="dirty-dot" />}</button><button role="tab" aria-selected={tab === 'diff'} className={tab === 'diff' ? 'active' : ''} onClick={() => { setTab('diff'); void loadDiff(); }}><GitCompareArrows size={15} />变更</button></div><IconButton label="刷新工作区" disabled={!connected || !project || filesLoading || diffLoading} onClick={() => tab === 'diff' ? void loadDiff() : void refreshFiles()}>{filesLoading || diffLoading ? <Spinner /> : <RefreshCw size={14} />}</IconButton></div>
          {uploadBusy && uploadProgress && <UploadProgress progress={uploadProgress} />}
          <div className="workbench-content">
            {tab === 'files' && <div className="files-pane"><div className="files-location"><Folder size={14} /><span title={directory || state.connection.workspace}>{directory ? directory.replace(connection?.home || '\0', '~') : state.connection.workspace}</span>{project && directory !== project.path && <IconButton label="返回上级目录" onClick={() => void refreshFiles(directory.slice(0, directory.lastIndexOf('/')) || '/')}><ArrowLeft size={14} /></IconButton>}</div><div className="files-toolbar"><div className="file-search"><Search size={13} /><input aria-label="筛选文件" placeholder="查找文件…" value={fileFilter} onChange={e => setFileFilter(e.target.value)} /></div><IconButton label="新建文件" disabled={!connected || !project} onClick={() => { setNewFileName(''); setNewFileModal(true); }}><FilePlus2 size={15} /></IconButton><IconButton label="上传文件" disabled={!connected || !project || !!uploadBusy} onClick={() => void upload()}>{uploadBusy === 'files' ? <Spinner /> : <Upload size={15} />}</IconButton><IconButton label="上传文件夹" disabled={!connected || !project || !!uploadBusy} onClick={() => void upload(false, 'folder')}>{uploadBusy === 'folder' ? <Spinner /> : <FolderUp size={15} />}</IconButton></div>
              {!connected ? <div className="panel-empty"><div className="empty-illustration"><FolderOpen size={37} strokeWidth={1.1} /><span className="illustration-dot" /></div><h3>尚未连接</h3><button className="secondary-button" onClick={openConnection}><Wifi size={14} />连接设备</button></div> : !project ? <div className="panel-empty"><FolderPlus size={30} /><h3>选择项目</h3><button className="secondary-button" onClick={openProjectModal}>打开项目</button></div> : fileError ? <div className="panel-empty error"><p>{fileError}</p><button className="secondary-button" onClick={() => void refreshFiles()}>重试</button></div> : filesLoading ? <div className="panel-empty"><Spinner /><p>正在读取远端文件…</p></div> : <div className="file-list">{files.filter(f => f.name.toLowerCase().includes(fileFilter.toLowerCase())).sort((a, b) => (a.type === 'directory' ? 0 : 1) - (b.type === 'directory' ? 0 : 1) || a.name.localeCompare(b.name)).map(file => <div className={`file-row ${openFile?.path === file.path ? 'selected' : ''}`} key={file.path}><button className="file-open" onClick={() => file.type === 'directory' ? void refreshFiles(file.path) : void openRemoteFile(file.path)}><FileIcon name={file.name} directory={file.type === 'directory'} /><span>{file.name}</span><small>{file.type === 'directory' ? '' : formatBytes(file.size)}</small>{file.type === 'directory' && <ChevronRight size={13} />}</button>{file.type === "directory" && <IconButton label={`打包下载 ${file.name}`} onClick={() => void downloadBundle(file.path)}><Download size={14} /></IconButton>}{file.type !== 'directory' && <IconButton label={`下载 ${file.name} 到 Windows`} onClick={() => void download(file.path)}><Download size={14} /></IconButton>}</div>)}{!files.length && !uploadBusy && <div className="panel-empty compact"><FolderOpen size={30} /><h3>这个文件夹还是空的</h3><div className="empty-upload-actions"><button className="text-button" disabled={!!uploadBusy} onClick={() => void upload()}>上传第一个文件</button><button className="text-button" aria-label="上传第一个文件夹" disabled={!!uploadBusy} onClick={() => void upload(false, 'folder')}>上传文件夹</button></div></div>}</div>}
              </div>}
            {tab === 'code' && <div className="code-pane">{openFile ? <><div className="editor-filebar"><FileIcon name={openFile.path} /><span title={openFile.path}>{baseName(openFile.path)}</span>{dirty && <span className="dirty-dot" />}<div className="editor-actions"><button className="reference-selection" disabled={!editorSelection} onClick={() => addSelection(`参考 ${openFile.path} 中的代码：\n\n${editorSelection}`)}>选中代码发到聊天</button><IconButton label="保存文件 · Ctrl+S" disabled={!dirty || !connected || fileBusy} onClick={() => void saveFile()}>{fileBusy ? <Spinner /> : <Save size={15} />}</IconButton><IconButton label="在终端准备运行当前文件" disabled={!connected || !!terminalJob} onClick={runFile}><Play size={15} /></IconButton><IconButton label="关闭文件" onClick={() => { if (canDiscard()) setOpenFile(null); }}><X size={14} /></IconButton></div></div><div className="editor-container"><CodeMirror value={openFile.content} height="100%" theme="light" extensions={[language].flat()} onChange={value => setOpenFile(f => f ? { ...f, content: value } : f)} onUpdate={update => { if (update.selectionSet) { const selection = update.state.selection.main; setEditorSelection(update.state.sliceDoc(selection.from, selection.to)); } }} editable={connected && !fileBusy} basicSetup={{ lineNumbers: true, highlightActiveLine: true, foldGutter: true }} aria-label="远端代码编辑器" /></div><div className="editor-footer"><span>{dirty ? '未保存' : '已同步'} · UTF-8</span><button className="download-file-button" onClick={() => void download(openFile.path)} disabled={!connected}><Download size={14} />下载到 Windows</button></div></> : <div className="panel-empty"><Code2 size={34} strokeWidth={1.3} /><h3>尚未打开文件</h3><button className="text-button" onClick={() => setTab('files')}>浏览项目文件</button></div>}</div>}
            {tab === 'diff' && <div className="diff-pane">{diffLoading ? <div className="panel-empty"><Spinner /><p>正在读取修改记录…</p></div> : !connected || !project ? <div className="panel-empty"><GitCompareArrows size={32} /><h3>尚未打开 Git 项目</h3></div> : diff && !diff.isGit ? <div className="panel-empty"><GitCompareArrows size={32} /><h3>当前目录不是 Git 仓库</h3></div> : diff?.diff ? <pre className="diff-content">{diff.diff.split('\n').map((line, index) => <div key={index} className={line.startsWith('+') && !line.startsWith('+++') ? 'addition' : line.startsWith('-') && !line.startsWith('---') ? 'deletion' : line.startsWith('@@') ? 'hunk' : ''}>{line || ' '}</div>)}</pre> : <div className="panel-empty"><CheckCircle2 size={32} /><h3>工作区没有差异</h3></div>}</div>}
          </div>
          {interactiveTerminal && project && <InteractiveTerminal projectPath={project.path} connected={connected} login={interactiveTerminal === "login"} onClose={() => setInteractiveTerminal(null)} onReference={addSelection} />}<div className={`terminal-pane ${terminalOpen ? 'expanded' : ''}`}><div className="terminal-heading"><button onClick={() => setTerminalOpen(!terminalOpen)}><Terminal size={15} /><span>终端</span>{terminalJob && <span className="small-pulse" />}<ChevronDown size={13} className={!terminalOpen ? 'rotated' : ''} /></button><div>{terminalJob && <IconButton label="停止终端程序" onClick={() => void stop(terminalJob)}><Square size={12} /></IconButton>}{terminalOpen && <IconButton label="清空终端显示" onClick={() => setTerminalOutput('')}><X size={13} /></IconButton>}<span>{connected ? '远程设备' : '未连接'}</span></div></div>{terminalOpen && <><div className="terminal-output" role="log" aria-label="终端运行输出"><pre>{terminalOutput}</pre><div ref={terminalBottom} /></div><div className="terminal-command-wrap"><CommandSuggestions controller={terminalCompletion} label="终端常用命令" className="terminal-command-menu" /><form className="terminal-input" onSubmit={e => { e.preventDefault(); void runCommand(terminalCommand); }}><span>{terminalJob ? '›' : '$'}</span><button type="button" className="terminal-command-button" aria-label="常用终端命令" title="常用终端命令" disabled={!connected || !!terminalJob} onClick={terminalCompletion.toggle}><Terminal size={12} /></button><input ref={terminalInputRef} aria-autocomplete="list" aria-controls={terminalCompletion.visible ? terminalCompletion.listId : undefined} aria-expanded={terminalCompletion.visible} aria-activedescendant={terminalCompletion.activeDescendant} onBlur={terminalCompletion.close} onKeyDown={e => { if (isComposingInput(e)) return; terminalCompletion.handleKeyDown(e); }} aria-label={terminalJob ? '发送到运行程序的输入' : '运行命令输入'} value={terminalCommand} onChange={e => setTerminalCommand(e.target.value)} placeholder={terminalJob ? '输入内容并发送给程序…' : '输入命令，例如 python3 main.py'} disabled={!connected || !project} /><button aria-label={terminalJob ? '发送终端输入' : '运行命令'} disabled={!terminalCommand.trim() || !connected || !project}><Play size={13} /></button></form></div></>}</div>
        </section></>}
      </div>
      <footer className="statusbar"><span><i className={`status-dot ${connected ? 'online' : ''}`} />{connected ? connection.hostname : '等待连接'}<span className="statusbar-separator" />{project?.path || '尚未打开项目'}</span><span>{transfer ? <><Spinner />{transfer.direction === 'download' ? '下载' : '上传'} {transfer.name} · {transfer.total ? `${Math.round((transfer.transferred || 0) / transfer.total * 100)}%` : formatBytes(transfer.transferred || 0)}</> : uploadBusy ? <><Spinner />正在上传{uploadBusy === 'folder' ? '文件夹' : '文件'}…</> : <><span className={`status-dot ${chatRun ? 'working' : ''}`} />{taskStatus}</>}</span></footer>
    </main>

    {toast && <div className={`toast ${toast.error ? 'error' : ''}`} role="status">{toast.error ? <Circle size={17} /> : <CheckCircle2 size={17} />}<span>{toast.text}</span>{toast.path && <button onClick={() => void api.showInFolder({ path: toast.path! }).catch(error => notify(errorText(error), true))}>打开位置</button>}<IconButton label="关闭提示" onClick={() => setToast(null)}><X size={14} /></IconButton></div>}
    {connectionModal && <Modal title="连接设备" onClose={() => { if (!connecting && !configSaving) setConnectionModal(false); }} wide><form onSubmit={connect} className="connection-form"><div className="form-grid"><label className="span-two">主机名或 IP 地址<input required autoComplete="off" value={draftConnection.host} onChange={e => setDraftConnection(c => ({ ...c, host: e.target.value }))} placeholder="server.example.com" /></label><label>SSH 端口<input required type="number" min={1} max={65535} value={draftConnection.port} onChange={e => setDraftConnection(c => ({ ...c, port: Number(e.target.value) }))} /></label><label className="span-three">登录用户<input required value={draftConnection.username} onChange={e => setDraftConnection(c => ({ ...c, username: e.target.value }))} autoComplete="username" /></label></div><div className="field-label">验证方式</div><div className="segmented"><button type="button" className={draftConnection.authType === 'key' ? 'active' : ''} onClick={() => setDraftConnection(c => ({ ...c, authType: 'key' }))}><KeyRound size={14} />SSH 密钥</button><button type="button" className={draftConnection.authType === 'password' ? 'active' : ''} onClick={() => setDraftConnection(c => ({ ...c, authType: 'password' }))}>密码</button><button type="button" className={draftConnection.authType === 'agent' ? 'active' : ''} onClick={() => setDraftConnection(c => ({ ...c, authType: 'agent' }))}>SSH Agent</button></div>{draftConnection.authType === 'key' && <><label>私钥文件<div className="input-with-button"><input required value={draftConnection.privateKeyPath || ''} onChange={e => setDraftConnection(c => ({ ...c, privateKeyPath: e.target.value }))} placeholder="选择电脑上的私钥文件" /><button type="button" onClick={() => void api.pickPrivateKey().then(path => { if (path) setDraftConnection(c => ({ ...c, privateKeyPath: path })); }).catch(error => setConnectionError(errorText(error)))}><FolderOpen size={16} />选择</button></div></label><label>密钥口令 <span className="optional">如有</span><input type="password" autoComplete="off" value={draftConnection.passphrase || ''} onChange={e => setDraftConnection(c => ({ ...c, passphrase: e.target.value }))} placeholder={savedCredentialMatches ? '已加密保存，留空使用已保存口令' : '没有口令可留空'} /></label></>}{draftConnection.authType === 'password' && <label>登录密码<input type="password" autoComplete="current-password" placeholder={savedCredentialMatches ? '已加密保存，留空使用已保存密码' : '首次连接请输入登录密码'} value={draftConnection.password || ''} onChange={e => setDraftConnection(c => ({ ...c, password: e.target.value }))} /></label>}{draftConnection.authType === 'agent' && <p className="form-help">使用本机已启动的 SSH Agent 中的密钥。</p>}<div className="form-divider" /><label>工作目录<input required value={draftConnection.workspace} onChange={e => setDraftConnection(c => ({ ...c, workspace: e.target.value }))} /></label><label>Claude 命令<input required value={draftConnection.claudePath} onChange={e => setDraftConnection(c => ({ ...c, claudePath: e.target.value }))} placeholder="claude 或完整可执行文件路径" /></label><label className="checkbox-label"><input type="checkbox" aria-label="启动时自动连接" checked={draftConnection.autoConnect !== false} onChange={e => setDraftConnection(c => ({ ...c, autoConnect: e.target.checked }))} /><span><strong>启动时自动连接</strong></span></label>{connectionError && <div className="form-error" role="alert">{connectionError}</div>}<div className="modal-actions">{connected ? <button type="button" className="text-button danger" onClick={() => void disconnect().then(() => setConnectionModal(false))}>断开连接</button> : <span />}<div><button type="button" className="secondary-button" disabled={!canSaveConnectionSettings} onClick={() => void saveConnectionSettings()}>{configSaving ? '正在保存…' : '仅保存配置'}</button><button className="primary-button" disabled={connecting || configSaving}>{connecting ? <Spinner /> : <Wifi size={15} />}{connecting ? '正在连接…' : '连接设备'}</button></div></div></form></Modal>}
    {projectModal && <Modal title="打开一个项目" onClose={() => { if (!projectBusy) setProjectModal(false); }}><form onSubmit={addProject}><div className="segmented"><button type="button" className={projectMode === 'create' ? 'active' : ''} onClick={() => setProjectMode('create')}>新建项目文件夹</button><button type="button" className={projectMode === 'open' ? 'active' : ''} onClick={() => setProjectMode('open')}>打开已有目录</button></div><label>项目名称<input required value={projectName} onChange={e => { const name = e.target.value; setProjectName(name); if (projectMode === 'create') setProjectPath(`${connection?.workspace}/${name.replace(/[\\/]/g, '-')}`); }} placeholder="例如 sample-project" /></label><label>项目目录<input required value={projectPath} onChange={e => setProjectPath(e.target.value)} /><small>{projectMode === 'open' ? '填写项目目录' : `应位于工作目录 ${connection?.workspace} 内。`}</small></label><div className="modal-actions"><span /><button className="primary-button" disabled={projectBusy}>{projectBusy ? <Spinner /> : <FolderPlus size={15} />}{projectMode === 'create' ? '创建并打开' : '打开项目'}</button></div></form></Modal>}
    {newFileModal && <Modal title="新建文件" subtitle={directory} onClose={() => setNewFileModal(false)}><form onSubmit={createFile}><label>文件名<input required value={newFileName} onChange={e => setNewFileName(e.target.value)} pattern="[^/\\\\]+" placeholder="例如 main.py" /></label><div className="modal-actions"><span /><button className="primary-button" disabled={fileBusy}>{fileBusy ? <Spinner /> : <FilePlus2 size={15} />}创建文件</button></div></form></Modal>}
    {imagePath && connected && <ImagePreview path={imagePath} onClose={() => setImagePath("")} onDownload={download} />}{filePicker && project && connected && <FilePicker projectPath={project.path} onClose={() => setFilePicker(false)} onSelect={path => setReferences(old => [...new Set([...old, path])])} />}{portsOpen && connected && <PortsPanel onClose={() => setPortsOpen(false)} />}{tasksOpen && project && connected && <TaskPanel projectPath={project.path} onClose={() => setTasksOpen(false)} onAttach={attachTask} />}{commandHelpModal && <Modal title="工作台常用命令" subtitle="输入 / 或点击输入框旁的 / 按钮，选择常用命令。" onClose={() => setCommandHelpModal(false)} wide><div className="commands-help-list">{chatCommands.map(item => <div key={item.id}><code>{item.command}</code><span>{item.description}{item.local ? '（工作台）' : ''}</span></div>)}</div><p className="commands-help-shortcut">↑↓ 选择，Tab / Enter 填入；Ctrl + Enter 发送。Shift + Enter 换行，Esc 关闭建议。</p></Modal>}
    {permissionModal && <Modal title="工作台权限设置" onClose={() => setPermissionModal(false)}><label className="checkbox-label"><input type="checkbox" checked={allowCommands} onChange={e => setAllowCommands(e.target.checked)} /><span><strong>允许 Claude 自主运行 shell 命令</strong><small>对后续“编辑文件”任务生效。</small></span></label><label className="checkbox-label"><input type="checkbox" checked={askCommands} disabled={allowCommands || !durableTasks} onChange={e => setAskCommands(e.target.checked)} /><span><strong>命令需要权限时，在聊天中询问我</strong><small>需开启断线后继续运行；未开启时，禁止 Claude 运行 shell 命令。</small></span></label><div className="modal-actions"><span /><button className="primary-button" onClick={() => setPermissionModal(false)}><Check size={15} />完成</button></div></Modal>}
  </div>;
}
