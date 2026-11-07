const { app, BrowserWindow, dialog, ipcMain, shell, session } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
const { RemoteClient } = require('./remote.cjs');
const { StateStore, safeFilename, atomicDownload } = require('./state.cjs');
const { CredentialStore, connectWithCredentials } = require('./credentials.cjs');
const { createUploadPlan, executeUploadPlan } = require('./uploads.cjs');
const { UpdateService } = require('./updates.cjs');

const testMode = process.env.CLOUDE_TEST || process.env.CLOUD_CLAUDE_TEST;
// The 2.0 launcher and the direct legacy entry use the same established profile.
const dataDirectory = require('./workspace-startup.cjs').configureProfile(app);
// A shared profile must have only one writer, including across app versions.
// Isolated integration fixtures intentionally use their own test processes.
if (!testMode && !app.requestSingleInstanceLock()) app.exit(0);
const store = new StateStore(dataDirectory);
const credentials = new CredentialStore(store);
const jobs = new Set();
const downloaded = new Set();
let operations = 0;
let uploading = false;
let window = null;
app.on('second-instance', () => {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show(); window.focus();
});
let connecting = false;
let quitting = false;
let shutdownStarted = false;
let shutdownFinished = false;
let activeConfig = null;
let connectionVersion = 0;
let hostKeys = {};
const pageUrl = pathToFileURL(path.join(__dirname, '..', 'dist', 'index.html')).href;

function send(payload) {
  if (payload.type === 'exit' && payload.jobId) jobs.delete(payload.jobId);
  if (payload.kind === 'connection' && payload.status === 'disconnected') { jobs.clear(); activeConfig = null; connectionVersion++; }
  if (window && !window.isDestroyed()) window.webContents.send('workspace:event', payload);
}

async function verifyHost({ host, port, fingerprint }) {
  const id = `${host}:${port}`;
  if (hostKeys[id] === fingerprint) return true;
  if (hostKeys[id]) {
    await dialog.showMessageBox(window, { type: 'error', title: 'SSH 主机密钥发生变化', message: '此设备的身份与上次连接不一致，已拒绝连接。', detail: `设备：${id}\n已记录：${hostKeys[id]}\n本次：${fingerprint}\n\n请先核实设备身份。确认是重装系统等正常变更后，可关闭应用并修改工作台数据目录中的 known-hosts.json。` });
    return false;
  }
  const choice = await dialog.showMessageBox(window, { type: 'question', title: '首次连接此设备', message: `信任 ${id} 的 SSH 主机密钥？`, detail: `SHA256 指纹：\n${fingerprint}\n\n请与设备端的 SSH 主机密钥指纹核对。信任后工作台会记录此指纹。`, buttons: ['取消', '信任并连接'], defaultId: 0, cancelId: 0, noLink: true });
  if (choice.response !== 1) return false;
  hostKeys[id] = fingerprint;
  await store.write('known-hosts.json', hostKeys);
  return true;
}
const remote = new RemoteClient({ emit: send, verifyHost });
const updates = new UpdateService({
  updater: app.isPackaged && process.platform === 'win32' && !testMode ? require('electron-updater').autoUpdater : null,
  version: app.getVersion(),
  supported: app.isPackaged && process.platform === 'win32' && !testMode,
  prepareInstall: async () => {
    if (jobs.size || operations || connecting || uploading) throw new Error('请先完成正在运行的任务和文件操作');
    // Reserve the connection boundary until the installer exits this process.
    connecting = true;
    try {
      await remote.disconnect();
      await credentials.queue;
      await store.queue;
      quitting = true;
    } catch (error) { connecting = false; throw error; }
  },
});
updates.on('change', state => send({ kind: 'update', update: state }));

function text(value, label, max = 32768) {
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) throw new Error(`${label}无效`);
  return value;
}
function params(value) { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('无效请求'); return value; }
function trusted(event) {
  if (!window || event.sender !== window.webContents || event.senderFrame !== event.sender.mainFrame || event.senderFrame.url.split('#')[0] !== pageUrl) throw new Error('拒绝来自非工作台页面的请求');
}
function handle(name, callback) { ipcMain.handle(`workspace:${name}`, async (event, value) => { trusted(event); return callback(value); }); }
function handleRemote(name, callback) {
  handle(name, async value => {
    if (connecting) throw new Error('正在连接，请稍候');
    operations++;
    try { return await callback(value); } finally { operations--; }
  });
}

handle('loadState', async () => {
  const state = await store.load();
  state.connection.credentialSaved = await credentials.has(state.connection).catch(() => false);
  return state;
});
handle('saveState', async value => {
  await store.save(value);
  if (value.connection?.autoConnect === false) await credentials.forget(value.connection);
});
handle('getUpdateState', () => updates.snapshot());
handle('checkForUpdates', () => updates.check());
handle('downloadUpdate', () => updates.download());
handle('installUpdate', () => updates.install());
handle('openReleases', () => {
  const { owner, repo } = require('../package.json').build.publish[0];
  return shell.openExternal(`https://github.com/${owner}/${repo}/releases/latest`);
});
handle('pickPrivateKey', async () => {
  const result = await dialog.showOpenDialog(window, { title: '选择 SSH 私钥文件', defaultPath: path.join(os.homedir(), '.ssh'), properties: ['openFile'] });
  return result.canceled ? null : result.filePaths[0];
});
handle('connect', async value => {
  params(value);
  if (connecting) throw new Error('正在连接，请稍候');
  if (jobs.size) throw new Error('请先停止正在运行的任务，再切换连接');
  if (operations) throw new Error('文件操作正在进行，请完成后再切换连接');
  connecting = true;
  connectionVersion++;
  try {
    const result = await connectWithCredentials(remote, credentials, value);
    const state = await store.load();
    const connectionKey = `${value.username}@${value.host}:${value.port || 22}:${value.workspace}`;
    for (const project of state.projects.filter(project => project.connectionKey === connectionKey)) {
      try { await remote.openProject(project.path); } catch { /* Missing projects remain visible so the user can fix their path. */ }
    }
    activeConfig = { host: value.host, port: value.port, username: value.username };
    return result;
  } finally { connecting = false; }
});
handle('disconnect', async () => {
  if (connecting) throw new Error('正在建立连接，请等待连接结果');
  if (operations) throw new Error('文件操作正在进行，请完成后再断开连接');
  if (jobs.size) {
    const answer = await dialog.showMessageBox(window, { type: 'warning', title: '断开设备', message: '仍有任务正在运行，是否请求停止并断开？', detail: '工作台会发送停止请求。网络异常时无法保证远端程序已经结束，重连后请核查。', buttons: ['保持连接', '停止并断开'], defaultId: 0, cancelId: 0 });
    if (answer.response !== 1) throw new Error('已取消断开');
  }
  await remote.disconnect(); activeConfig = null; jobs.clear();
});
handleRemote('listFiles', value => remote.listFiles(text(params(value).path, '目录')));
handleRemote('openProject', value => remote.openProject(text(params(value).path, '项目目录')));
handleRemote('listSessions', value => remote.listSessions(text(params(value).projectPath, '项目目录')));
handleRemote('readSession', value => {
  params(value);
  return remote.readSession(text(value.projectPath, '项目目录'), text(value.sessionId, '会话 ID', 128));
});
handleRemote('readFile', value => remote.readFile(text(params(value).path, '文件路径')));
handleRemote('saveFile', value => {
  params(value);
  return remote.saveFile(text(value.path, '文件路径'), text(value.content, '文件内容', 4 * 1024 * 1024), value.expectedMtime);
});
handleRemote('mkdir', value => remote.mkdir(text(params(value).path, '目录')));
handleRemote('getDiff', value => remote.getDiff(text(params(value).projectPath, '项目路径')));
handle('getModels', async value => {
  if (connecting) throw new Error('正在连接，请稍候');
  if (!activeConfig) throw new Error('请先连接设备');
  const version = connectionVersion;
  const projectPath = value?.projectPath ? text(value.projectPath, '项目路径') : undefined;
  const result = await remote.getModels(projectPath);
  if (version !== connectionVersion || !activeConfig) throw new Error('连接已变化，请刷新模型列表。');
  return result;
});
handle('getUsage', async () => {
  if (connecting) throw new Error('正在连接，请稍候');
  if (!activeConfig) throw new Error('请先连接设备');
  const version = connectionVersion;
  const result = await remote.getUsage();
  if (version !== connectionVersion || !activeConfig) throw new Error('连接已变化，请刷新当前设备的账户用量。');
  return result;
});
handleRemote('download', async value => {
  const remotePath = text(params(value).path, '文件路径');
  if (!activeConfig) throw new Error('请先连接设备');
  const version = connectionVersion;
  const answer = await dialog.showSaveDialog(window, { title: '下载到 Windows', defaultPath: path.join(app.getPath('downloads'), safeFilename(remotePath)), buttonLabel: '下载', properties: ['showOverwriteConfirmation', 'createDirectory'] });
  if (answer.canceled || !answer.filePath) return { canceled: true };
  if (version !== connectionVersion || !activeConfig) throw new Error('连接已变化，请重新选择要下载的文件');
  const result = await atomicDownload(remote, remotePath, answer.filePath);
  downloaded.add(path.resolve(answer.filePath));
  return result;
});
handleRemote('upload', async value => {
  const directory = text(params(value).directory, '目标目录');
  const kind = value.kind || 'files';
  if (!['files', 'folder'].includes(kind)) throw new Error('上传类型无效');
  if (!activeConfig) throw new Error('请先连接设备');
  if (uploading) throw new Error('已有上传正在进行，请等待当前上传完成');
  uploading = true;
  try {
    const version = connectionVersion;
    const assertCurrent = () => {
      if (version !== connectionVersion || !activeConfig) throw new Error('连接已变化，上传已中断，请重新选择上传目录');
    };
    const answer = await dialog.showOpenDialog(window, {
      title: kind === 'folder' ? '上传文件夹到 远程设备' : '上传文件到 远程设备',
      properties: kind === 'folder' ? ['openDirectory'] : ['openFile', 'multiSelections'],
    });
    if (answer.canceled || !answer.filePaths.length) return { canceled: true };
    assertCurrent();
    let lastReport = 0;
    let lastPhase = '';
    const reportProgress = progress => {
      if (version !== connectionVersion || !activeConfig) return;
      const now = Date.now();
      if (progress.phase === lastPhase && now - lastReport < 120) return;
      lastReport = now; lastPhase = progress.phase;
      send({ kind: 'transfer', direction: 'upload', type: 'upload-progress', ...progress });
    };
    reportProgress({ phase: 'scanning', entriesProcessed: 0 });
    const plan = await createUploadPlan(remote, { directory, localPaths: answer.filePaths, kind }, assertCurrent, reportProgress);
    if (plan.conflicts.length) {
      reportProgress({ phase: 'confirming' });
      const shown = plan.conflicts.slice(0, 25).map(file => {
        const relative = path.posix.relative(plan.directory, file);
        return relative.length > 180 ? '…' + relative.slice(-179) : relative;
      });
      if (plan.conflicts.length > shown.length) shown.push(`另有 ${plan.conflicts.length - shown.length} 个同名文件。`);
      const confirmation = await dialog.showMessageBox(window, {
        type: 'warning', title: '覆盖同名文件', message: `远程设备上已有 ${plan.conflicts.length} 个同名文件，是否覆盖？`,
        detail: shown.join('\n'), buttons: ['取消', '覆盖并上传'], defaultId: 0, cancelId: 0,
      });
      if (confirmation.response !== 1) return { canceled: true };
    }
    assertCurrent();
    return { canceled: false, ...await executeUploadPlan(remote, plan, assertCurrent, reportProgress) };
  } finally { uploading = false; }
});
async function start(kind, value) {
  params(value);
  const jobId = text(value.jobId, '任务标识', 128);
  if (!/^[\w-]+$/.test(jobId)) throw new Error('任务标识无效');
  if (!activeConfig) throw new Error('请先连接设备');
  if (jobs.has(jobId)) throw new Error('此任务已经启动');
  if (jobs.size >= 4) throw new Error('最多同时运行 4 个任务');
  jobs.add(jobId);
  try { return await remote[kind](value); }
  catch (error) { jobs.delete(jobId); throw error; }
}
handle('startChat', value => start('startChat', value));
handle('runCommand', value => start('runCommand', value));
handle('writeJob', value => remote.writeJob(text(params(value).jobId, '任务标识', 128), text(value.data, '终端输入', 65536)));
handle('stopJob', value => remote.stopJob(text(params(value).jobId, '任务标识', 128)));
handle('showInFolder', value => {
  const target = path.resolve(text(params(value).path, '文件路径'));
  if (!downloaded.has(target)) throw new Error('只能打开本次下载文件所在的位置');
  shell.showItemInFolder(target);
});
handle('openExternal', async value => {
  const url = new URL(text(params(value).url, '链接', 4096));
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('仅支持 http(s) 链接');
  return shell.openExternal(url.href);
});

const features = require('./desktop-features.cjs').registerDesktopFeatures({
  electron: require('electron'), remote, handle, handleRemote, getWindow: () => window,
  dataDirectory, getConnectionVersion: () => connectionVersion, isConnected: () => !!activeConfig,
  send, startTerminal: value => start('openTerminal', value),
});

async function createWindow() {
  hostKeys = await store.read('known-hosts.json', {});
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  window = new BrowserWindow({ width: 1480, height: 960, minWidth: 1040, minHeight: 700, title: 'Cloude', icon: path.join(__dirname, '..', 'assets', 'claude-icon.png'), backgroundColor: '#f8f6f1', autoHideMenuBar: true, show: false, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false, webSecurity: true } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.on('will-prevent-unload', event => {
    const choice = dialog.showMessageBoxSync(window, { type: 'question', title: '尚有未保存的修改', message: '编辑器中的修改尚未保存，确定退出吗？', buttons: ['返回编辑', '放弃修改并退出'], defaultId: 0, cancelId: 0 });
    if (choice === 1) event.preventDefault();
  });
  window.once('ready-to-show', () => { if (!testMode) window.show(); });
  window.on('close', event => {
    if (quitting || (!jobs.size && !operations)) return;
    event.preventDefault();
    const answer = dialog.showMessageBoxSync(window, { type: 'warning', title: '退出工作台', message: '仍有任务或文件操作正在进行，是否请求停止并退出？', detail: '退出会中断 SSH 连接和未完成的传输。远端程序是否停止需以后续检查为准。', buttons: ['继续使用', '停止并退出'], defaultId: 0, cancelId: 0 });
    if (answer === 1) { quitting = true; Promise.resolve(remote.disconnect()).finally(() => app.quit()); }
  });
  await window.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  if (updates.state.status !== 'unsupported') {
    const timer = setTimeout(() => { void updates.check(); }, 15000);
    timer.unref();
  }
  return window;
}

const ready = app.whenReady().then(createWindow).catch(error => { dialog.showErrorBox('Cloude 启动失败', error.message); app.quit(); throw error; });
app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => {
  if (shutdownFinished) return;
  event.preventDefault();
  if (shutdownStarted) return;
  shutdownStarted = true;
  Promise.resolve(remote.disconnect()).catch(() => {}).then(() => credentials.queue).then(() => store.queue).finally(() => {
    shutdownFinished = true;
    app.quit();
  });
});
const restartApplication = require('./workspace-restart.cjs').createWorkspaceRestarter({ app, getWindows: () => window ? [window] : [] });
async function restartWorkspace(args) {
  if (jobs.size || operations || connecting || uploading) throw new Error('请先完成正在运行的任务和文件操作，再切换工作台。');
  return restartApplication(args);
}
module.exports = { ready, getWindow: () => window, remote, store, credentials, updates, features, restartWorkspace };
