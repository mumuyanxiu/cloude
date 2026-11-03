export interface ConnectionConfig {
  host: string; port: number; username: string; authType: 'key' | 'password' | 'agent';
  privateKeyPath?: string; password?: string; passphrase?: string; workspace: string; claudePath: string;
  autoConnect?: boolean; credentialSaved?: boolean;
}
export interface Project { id: string; name: string; path: string; connectionKey?: string }
export interface ToolCall { id: string; name: string; input?: unknown; result?: string }
export interface Message { id: string; role: 'user' | 'assistant'; content: string; tools?: ToolCall[]; files?: string[]; error?: boolean }
export interface Conversation { id: string; projectId: string; title: string; sessionId?: string; messages: Message[]; updatedAt: number; historyNotice?: string }
export interface RemoteSession { sessionId: string; title: string; updatedAt: number }
export interface AppState { connection: ConnectionConfig; projects: Project[]; conversations: Conversation[]; settings?: { activeProjectId?: string; activeConversationId?: string; panelWidth?: number; allowCommands?: boolean } }
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
  kind: 'connection' | 'chat' | 'terminal' | 'transfer' | 'update';
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
  startChat(options: { jobId: string; conversationId: string; projectPath: string; prompt: string; sessionId?: string; mode: 'plan' | 'edit'; allowCommands?: boolean; model?: string }): Promise<{ jobId: string }>;
  runCommand(options: { jobId: string; projectPath: string; command: string }): Promise<{ jobId: string }>;
  writeJob(options: { jobId: string; data: string }): Promise<void>; stopJob(options: { jobId: string }): Promise<void>;
  getDiff(options: { projectPath: string }): Promise<{ diff: string; isGit: boolean }>;
  showInFolder(options: { path: string }): Promise<void>;
  openExternal?(options: { url: string }): Promise<void>;
  onEvent(callback: (event: RemoteEvent) => void): () => void;
}
declare global { interface Window { workspace?: DesktopAPI } }
