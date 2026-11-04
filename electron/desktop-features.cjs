'use strict';
const fs = require('node:fs/promises');
const fss = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { spawn } = require('node:child_process');
const { createUploadPlan, executeUploadPlan, inspectLocalPath } = require('./uploads.cjs');
const { imageMime, MEDIA_LIMIT } = require('./remote-features.cjs');
const { safeFilename, atomicDownload } = require('./state.cjs');

function fileDropList() {
  if (process.platform !== 'win32') return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    const script = '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); Add-Type -AssemblyName System.Windows.Forms; ConvertTo-Json -Compress -InputObject @([System.Windows.Forms.Clipboard]::GetFileDropList())';
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', script], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; const timer = setTimeout(() => { child.kill(); reject(new Error('读取文件剪贴板超时')); }, 5000);
    child.stdout.on('data', data => { output += data.toString(); if (output.length > 65536) child.kill(); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); if (code !== 0) return resolve([]); try { const data = JSON.parse(output || '[]'); resolve(Array.isArray(data) ? data.filter(x => typeof x === 'string') : []); } catch { resolve([]); } });
  });
}

class AttachmentStore {
  constructor(directory, electron) { this.directory = directory; this.electron = electron; this.entries = new Map(); }
  async add(localPath, owned = false) {
    if (this.entries.size >= 100) throw new Error('待发送附件过多，请移除或发送已有附件');
    const stats = await inspectLocalPath(localPath);
    const id = crypto.randomUUID(); const name = path.basename(localPath);
    const entry = { id, localPath, name, size: stats.size, kind: stats.isDirectory() ? 'folder' : 'file', owned };
    this.entries.set(id, entry);
    const result = { id, name, size: stats.size, kind: entry.kind };
    if (stats.isFile() && stats.size <= MEDIA_LIMIT && /\.(png|jpe?g|webp|gif)$/i.test(name)) {
      const bytes = await fs.readFile(localPath); const mime = imageMime(bytes);
      if (mime) { result.mime = mime; const native = this.electron.nativeImage.createFromBuffer(bytes); if (!native.isEmpty()) result.preview = native.resize({ width: 180 }).toDataURL(); }
    }
    return result;
  }
  async image(bytes, mime) {
    if (!(bytes instanceof ArrayBuffer) && !(bytes instanceof Uint8Array)) throw new Error('图片数据格式无效');
    if (bytes.byteLength > MEDIA_LIMIT) throw new Error('图片超过 20 MB');
    const buffer = Buffer.from(bytes);
    if (!buffer.length || buffer.length > MEDIA_LIMIT || !imageMime(buffer)) throw new Error('图片无效或超过 20 MB');
    await fs.mkdir(this.directory, { recursive: true });
    const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }[imageMime(buffer)];
    const target = path.join(this.directory, `截图-${crypto.randomUUID()}.${extension}`);
    await fs.writeFile(target, buffer, { flag: 'wx', mode: 0o600 });
    try { return await this.add(target, true); } catch (error) { await fs.rm(target, { force: true }); throw error; }
  }
  async discard(ids) {
    for (const id of ids) { const entry = this.entries.get(id); if (!entry) continue; this.entries.delete(id); if (entry.owned && path.dirname(entry.localPath) === this.directory) await fs.rm(entry.localPath, { force: true }).catch(() => {}); }
  }
}

function registerDesktopFeatures(context) {
  const { electron, remote, handle, handleRemote, getWindow, dataDirectory, getConnectionVersion, isConnected, send } = context;
  const { clipboard, ClipboardItem, dialog, shell, app, Notification } = electron;
  const attachments = new AttachmentStore(path.join(dataDirectory, 'attachments'), electron);
  let transferBusy = false;
  const checkConnected = () => { if (!isConnected()) throw new Error('请先连接设备'); return getConnectionVersion(); };
  const assertVersion = version => { if (!isConnected() || version !== getConnectionVersion()) throw new Error('连接已变化，请重新选择目标'); };
  const idsOf = value => { if (!Array.isArray(value) || value.length > 32 || value.some(x => typeof x !== 'string')) throw new Error('附件列表无效'); return value; };
  handle('stageClipboard', async () => {
    const files = await fileDropList();
    if (files.length) { if (files.length > 32) throw new Error('一次最多粘贴 32 个附件'); return Promise.all(files.map(file => attachments.add(file))); }
    const items = await clipboard.read();
    for (const item of items) {
      const type = item.types.find(type => ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(type));
      if (type) { const blob = await item.getType(type); return [await attachments.image(await blob.arrayBuffer(), type)]; }
    }
    return [];
  });
  handle('stageDropped', async value => {
    if (!Array.isArray(value) || value.length > 32) throw new Error('一次最多添加 32 个附件');
    const result = [];
    for (const file of value) {
      if (typeof file.path === 'string' && file.path) result.push(await attachments.add(file.path));
      else result.push(await attachments.image(file.bytes, file.mime));
    }
    return result;
  });
  handle('discardAttachments', value => attachments.discard(idsOf(value.ids)));
  handleRemote('uploadAttachments', async value => {
    if (transferBusy) throw new Error('附件正在上传，请稍候');
    const version = checkConnected(); const entries = idsOf(value.ids).map(id => { const entry = attachments.entries.get(id); if (!entry) throw new Error('附件已失效，请重新添加'); return entry; });
    const root = await remote._directory(value.projectPath);
    transferBusy = true;
    try {
      const base = await remote.mkdir(`${root}/.cloude-attachments`);
      const batch = await remote.mkdir(`${base.path}/${crypto.randomUUID()}`);
      const results = [];
      for (const entry of entries) {
        assertVersion(version);
        // Each item gets its own directory so equal names never overwrite each other.
        const destination = (await remote.mkdir(`${batch.path}/${entry.id}`)).path;
        const progress = data => send({ kind: 'transfer', direction: 'upload', type: 'upload-progress', ...data });
        const plan = await createUploadPlan(remote, { directory: destination, localPaths: [entry.localPath], kind: entry.kind === 'folder' ? 'folder' : 'files' }, () => assertVersion(version), progress);
        const uploaded = await executeUploadPlan(remote, plan, () => assertVersion(version), progress);
        results.push({ id: entry.id, name: entry.name, kind: entry.kind, size: entry.size, path: entry.kind === 'folder' ? uploaded.folders[0] : uploaded.files[0] });
      }
      return results;
    } finally { transferBusy = false; }
  });
  handleRemote('readMedia', value => remote.readMedia(value.path));
  handleRemote('copyImage', async value => {
    const result = await remote.readMedia(value.path);
    const bytes = Buffer.from(result.dataUrl.split(',')[1], 'base64');
    // PNG is the portable clipboard representation, including JPEG/WebP sources.
    const png = electron.nativeImage.createFromBuffer(bytes).toPNG();
    await clipboard.write([new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) })]);
  });
  handle('copyText', value => { if (typeof value.text !== 'string' || value.text.length > 2 * 1024 * 1024) throw new Error('复制内容过长'); return clipboard.writeText(value.text); });
  handleRemote('searchFiles', value => remote.searchFiles(value));
  handle('openTerminal', value => context.startTerminal(value));
  handle('resizeTerminal', value => remote.resizeTerminal(value));
  handleRemote('forwardPort', value => remote.forwardPort(value));
  handle('listPorts', () => remote.listPorts());
  handle('closePort', value => remote.closePort(value.id));
  for (const name of ['startPersistentChat', 'listTasks', 'pollTask', 'replyTask', 'stopTask']) handleRemote(name, value => remote[name](value));
  handle('notifyTask', value => {
    if (!Notification.isSupported() || !getWindow() || getWindow().isDestroyed() || getWindow().isFocused()) return;
    if (!['completed', 'failed', 'waiting'].includes(value.state)) return;
    const key = `${value.jobId}:${value.state}:${value.requestId || ''}`;
    if (notifications.has(key)) return;
    notifications.add(key); if (notifications.size > 1000) notifications.delete(notifications.values().next().value);
    const notification = new Notification({ title: value.state === 'waiting' ? 'Cloude · 等待回答' : value.state === 'completed' ? 'Cloude · 任务完成' : 'Cloude · 任务失败', body: String(value.title || '打开工作台查看任务').slice(0, 160), silent: false });
    notification.on('click', () => { const window = getWindow(); if (window?.isMinimized()) window.restore(); window?.show(); window?.focus(); send({ kind: 'navigate', conversationId: String(value.conversationId || '') }); });
    notification.show();
  });
  const notifications = new Set();
  handleRemote('openLocalFile', async value => {
    const version = checkConnected();
    const target = await remote.resolvePath(value.path);
    const name = safeFilename(target);
    if (!/\.(png|jpg|jpeg|gif|webp|pdf|txt|md|csv|json|log|mp4|webm|wav|mp3|xlsx|docx|pptx)$/i.test(name)) throw new Error('此文件类型请下载后自行打开');
    const directory = path.join(dataDirectory, 'opened-files', crypto.randomUUID());
    await fs.mkdir(directory, { recursive: true });
    const destination = path.join(directory, name);
    await atomicDownload(remote, target, destination); assertVersion(version);
    const error = await shell.openPath(destination); if (error) throw new Error(error);
    return { name };
  });
  handleRemote('downloadBundle', async value => {
    const version = checkConnected(); const root = await remote._directory(value.path);
    const choice = await dialog.showSaveDialog(getWindow(), { title: '下载文件夹为 ZIP', defaultPath: path.join(app.getPath('downloads'), safeFilename(root) + '.zip'), filters: [{ name: 'ZIP 压缩文件', extensions: ['zip'] }], properties: ['showOverwriteConfirmation', 'createDirectory'] });
    if (choice.canceled || !choice.filePath) return { canceled: true };
    assertVersion(version);
    const staging = await fs.mkdtemp(path.join(app.getPath('temp'), 'cloude-bundle-'));
    const temp = path.join(path.dirname(choice.filePath), `.${path.basename(choice.filePath)}.${crypto.randomUUID()}.part`);
    try {
      const zip = new (require('yazl').ZipFile)(); const entries = []; const queue = [root]; let total = 0;
      while (queue.length) {
        for (const entry of await remote.listFiles(queue.shift())) {
          assertVersion(version);
          if (entry.type === 'symlink') throw new Error(`文件夹包含符号链接，请单独下载所需文件：${entry.name}`);
          if (entry.type === 'directory') queue.push(entry.path);
          entries.push(entry); total += entry.type === 'file' ? entry.size : 0;
          if (entries.length > 10000 || total > 1024 ** 3) throw new Error('批量下载限制为 10000 项、1 GB，请缩小所选目录');
        }
      }
      for (const [index, entry] of entries.entries()) {
        assertVersion(version);
        const relative = path.posix.relative(root, entry.path);
        if (!relative || relative.startsWith('../') || relative.includes('\\')) throw new Error('文件名不适合 ZIP 归档');
        if (entry.type === 'directory') zip.addEmptyDirectory(relative);
        else { const local = path.join(staging, String(index)); await remote.download(entry.path, local); zip.addFile(local, relative); }
      }
      const completion = pipeline(zip.outputStream, fss.createWriteStream(temp, { flags: 'wx' }));
      zip.end(); await completion; assertVersion(version); await fs.rename(temp, choice.filePath);
      return { canceled: false, files: entries.filter(e => e.type === 'file').length };
    } finally {
      await fs.rm(temp, { force: true }).catch(() => {});
      if (path.dirname(staging) === app.getPath('temp') && path.basename(staging).startsWith('cloude-bundle-')) await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
    }
  });
  return { attachments };
}
module.exports = { registerDesktopFeatures, AttachmentStore, fileDropList };
