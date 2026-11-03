import type { AppState, DesktopAPI } from './types';
export const defaultConnection = { host: '', port: 22, username: '', authType: 'key' as const, privateKeyPath: '', workspace: '~/claude-workspace', claudePath: 'claude', autoConnect: true };
export const emptyState: AppState = { connection: defaultConnection, projects: [], conversations: [] };
export const isDesktop = !!window.workspace;
const desktopOnly = async (): Promise<never> => { throw new Error('请在 Cloud Claude 桌面应用中使用此功能'); };
export const api: DesktopAPI = window.workspace ?? {
  loadState: async () => emptyState, saveState: async () => {}, onEvent: () => () => {},
  getUpdateState: async () => ({ status: 'unsupported', currentVersion: '', version: null, percent: 0, message: '' }),
  checkForUpdates: desktopOnly, downloadUpdate: desktopOnly, installUpdate: desktopOnly, openReleases: desktopOnly,
  pickPrivateKey: desktopOnly, connect: desktopOnly, disconnect: desktopOnly, getUsage: desktopOnly,
  openProject: desktopOnly, listSessions: desktopOnly, readSession: desktopOnly,
  listFiles: desktopOnly, readFile: desktopOnly, saveFile: desktopOnly, mkdir: desktopOnly,
  download: desktopOnly, upload: desktopOnly, startChat: desktopOnly, runCommand: desktopOnly,
  writeJob: desktopOnly, stopJob: desktopOnly, getDiff: desktopOnly, showInFolder: desktopOnly, openExternal: desktopOnly,
};
export const id = () => crypto.randomUUID();
export const errorText = (error: unknown) => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : String(error);
export const baseName = (path: string) => path.replace(/\/$/, '').split('/').pop() || path;
export const formatBytes = (size: number) => size < 1024 ? `${Math.floor(size)} B` : size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KB` : size < 1024 ** 3 ? `${(size / 1024 ** 2).toFixed(1)} MB` : `${(size / 1024 ** 3).toFixed(2)} GB`;
export const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
// Plain log viewer: remove complete ANSI color/cursor/OSC sequences. Keeping
// incomplete sequences until the next append handles escape codes split by SSH.
export const cleanTerminalOutput = (value: string) => value
  .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
  .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
  .replace(/\r\n/g, '\n').replace(/\r/g, '\n');
