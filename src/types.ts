export interface ConnectionConfig {
  host: string; port: number; username: string; authType: 'key' | 'password' | 'agent';
  privateKeyPath?: string; password?: string; passphrase?: string; workspace: string; claudePath: string;
  autoConnect?: boolean; credentialSaved?: boolean;
}
export interface Project { id: string; name: string; path: string; connectionKey?: string }
export interface ToolCall { id: string; name: string; input?: unknown; result?: string }
export interface Attachment { id: string; name: string; kind: 'file' | 'folder'; size: number; mime?: string; preview?: string; path?: string }
export interface Message { id: string; role: 'user' | 'assistant'; content: string; tools?: ToolCall[]; files?: string[]; attachments?: Attachment[]; error?: boolean; jobId?: string }
export interface Conversation { id: string; projectId: string; title: string; sessionId?: string; messages: Message[]; updatedAt: number; historyNotice?: string; historyLoaded?: boolean; task?: { jobId: string; messageId: string; cursor: number; finished?: boolean } }
export interface PermissionRequest { type: string; request_id: string; request: { subtype: string; tool_name: string; input: Record<string, any>; decision_reason?: string; blocked_path?: string } }
export interface RemoteTask { jobId: string; conversationId: string; projectPath: string; title: string; state: 'starting' | 'running' | 'waiting' | 'completed' | 'failed' | 'stopped' | 'interrupted'; createdAt: number; updatedAt: number; sessionId?: string; pendingRequests: PermissionRequest[]; message?: string; exitCode?: number }
export interface PortForward { id: string; remotePort: number; localPort: number; url: string }
export interface RemoteSession { sessionId: string; title: string; updatedAt: number }
export type ClaudeEffort = '' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export interface AppState { connection: ConnectionConfig; projects: Project[]; conversations: Conversation[]; settings?: { activeProjectId?: string; activeConversationId?: string; panelWidth?: number; durableTasks?: boolean; notifications?: boolean; model?: string; customModel?: string; effort?: ClaudeEffort } }
export interface FileEntry { name: string; path: string; type: 'directory' | 'file' | 'symlink'; size: number; mtime: number }
export interface ConnectionInfo { home: string; workspace: string; hostname: string; claudeVersion: string; claudeAvailable: boolean; warning?: string; credentialSaved?: boolean }
export interface AccountUsage {
  available: boolean;
  limits: Array<{ kind: string; group: string; percent: number; resetsAt: string | null; label: string; severity?: string }>;
  fetchedAt: number;
  message?: string;
}
export interface UpdateState {
  status: 'unsupported' | 'idle' | 'checking' | 'latest' | 'available' | 'downloading' | 'downloaded' | 'error';
  currentVersion: string; version: string | null; percent: number; message: string;
}
export interface RemoteEvent {
  kind: 'connection' | 'chat' | 'terminal' | 'transfer' | 'update' | 'navigate' | 'tunnel';
  update?: UpdateState;
  status?: string; message?: string; jobId?: string; conversationId?: string;
  type?: string; event?: Record<string, any>; data?: string; code?: number | null; signal?: string; stopped?: boolean;
  direction?: 'download' | 'upload'; name?: string; transferred?: number; total?: number;
  phase?: UploadProgressData['phase']; entriesProcessed?: number; entriesTotal?: number;
  filesCompleted?: number; filesTotal?: number; bytesTransferred?: number; bytesTotal?: number;
  fileTransferred?: number; fileTotal?: number;
}
export interface UploadProgressData {
  phase: 'selecting' | 'scanning' | 'checking' | 'confirming' | 'preparing' | 'uploading' | 'committing' | 'verifying' | 'complete';
  name?: string; entriesProcessed?: number; entriesTotal?: number;
  filesCompleted?: number; filesTotal?: number; bytesTransferred?: number; bytesTotal?: number;
  fileTransferred?: number; fileTotal?: number; updatedAt: number; startedAt: number; transferStartedAt?: number;
}
export interface DesktopAPI {
  stageClipboard(): Promise<Attachment[]>;
  stageDropped(files: File[]): Promise<Attachment[]>;
  discardAttachments(options: { ids: string[] }): Promise<void>;
  uploadAttachments(options: { ids: string[]; projectPath: string }): Promise<Attachment[]>;
  readMedia(options: { path: string }): Promise<{ path: string; mime: string; size: number; dataUrl: string }>;
  copyImage(options: { path: string }): Promise<void>;
  copyText(options: { text: string }): Promise<void>;
  searchFiles(options: { projectPath: string; query: string }): Promise<{ files: FileEntry[]; truncated: boolean }>;
  openTerminal(options: { jobId: string; projectPath: string; cols?: number; rows?: number; login?: boolean }): Promise<{ jobId: string }>;
  resizeTerminal(options: { jobId: string; cols: number; rows: number }): Promise<void>;
  forwardPort(options: { remotePort: number; localPort?: number }): Promise<PortForward>;
  listPorts(): Promise<PortForward[]>;
  closePort(options: { id: string }): Promise<void>;
  startPersistentChat(options: { jobId: string; conversationId: string; projectPath: string; prompt: string; sessionId?: string; mode: 'plan' | 'edit'; model?: string; effort?: ClaudeEffort }): Promise<{ jobId: string }>;
  listTasks(options: { projectPath: string }): Promise<{ tasks: RemoteTask[] }>;
  pollTask(options: { projectPath: string; jobId: string; cursor: number }): Promise<{ task: RemoteTask; events: Array<{ type: string; event?: Record<string, any>; data?: string }>; cursor: number; more: boolean }>;
  replyTask(options: { projectPath: string; jobId: string; requestId: string; allow: boolean; scope?: 'once' | 'project'; answers?: Record<string, string> }): Promise<void>;
  stopTask(options: { projectPath: string; jobId: string }): Promise<void>;
  notifyTask(options: { jobId: string; state: string; title: string; conversationId: string; requestId?: string }): Promise<void>;
  openLocalFile(options: { path: string }): Promise<{ name: string }>;
  downloadBundle(options: { path: string }): Promise<{ canceled: boolean; files?: number }>;
  getUpdateState(): Promise<UpdateState>; checkForUpdates(): Promise<UpdateState>;
  downloadUpdate(): Promise<UpdateState>; installUpdate(): Promise<void>; openReleases(): Promise<void>;
  loadState(): Promise<AppState>; saveState(state: AppState): Promise<void>;
  pickPrivateKey(): Promise<string | null>; connect(config: ConnectionConfig): Promise<ConnectionInfo>; disconnect(): Promise<void>;
  getUsage(): Promise<AccountUsage>;
  listFiles(options: { path: string }): Promise<FileEntry[]>;
  openProject(options: { path: string }): Promise<{ path: string; name: string }>;
  listSessions(options: { projectPath: string }): Promise<{ sessions: RemoteSession[]; warning?: string }>;
  readSession(options: { projectPath: string; sessionId: string }): Promise<RemoteSession & { messages: Message[]; truncated: boolean; notice: string }>;
  readFile(options: { path: string }): Promise<{ content: string; mtime: number; size: number }>;
  saveFile(options: { path: string; content: string; expectedMtime?: number | null }): Promise<{ mtime: number; size: number }>;
  mkdir(options: { path: string }): Promise<{ path: string }>;
  download(options: { path: string }): Promise<{ canceled: boolean; localPath?: string; bytes?: number }>;
  upload(options: { directory: string; kind?: 'files' | 'folder' }): Promise<{ canceled: boolean; files?: string[]; folders?: string[] }>;
  startChat(options: { jobId: string; conversationId: string; projectPath: string; prompt: string; sessionId?: string; mode: 'plan' | 'edit'; model?: string; effort?: ClaudeEffort }): Promise<{ jobId: string }>;
  runCommand(options: { jobId: string; projectPath: string; command: string }): Promise<{ jobId: string }>;
  writeJob(options: { jobId: string; data: string }): Promise<void>; stopJob(options: { jobId: string }): Promise<void>;
  getDiff(options: { projectPath: string }): Promise<{ diff: string; isGit: boolean }>;
  showInFolder(options: { path: string }): Promise<void>;
  openExternal?(options: { url: string }): Promise<void>;
  onEvent(callback: (event: RemoteEvent) => void): () => void;
}
declare global { interface Window { workspace?: DesktopAPI } }
