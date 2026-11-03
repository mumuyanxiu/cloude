const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');

async function replaceWithRetry(source, target, { rename = fs.rename, wait = delay, platform = process.platform } = {}) {
  const pauses = platform === 'win32' ? [50, 100, 200, 400] : [];
  for (let attempt = 0; ; attempt++) {
    try { await rename(source, target); return; }
    catch (error) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= pauses.length) throw error;
      // Antivirus/indexing can briefly hold the destination open on Windows.
      // Keep atomic replacement: never delete the original to make room.
      await wait(pauses[attempt]);
    }
  }
}

const defaults = () => ({
  connection: { host: '', port: 22, username: '', authType: 'key', privateKeyPath: '', workspace: '~/claude-workspace', claudePath: 'claude', autoConnect: true },
  projects: [], conversations: [], settings: {},
});

function cleanState(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('无效的工作台配置');
  const result = defaults();
  const connection = input.connection || {};
  for (const field of ['host', 'username', 'authType', 'privateKeyPath', 'workspace', 'claudePath']) {
    if (typeof connection[field] === 'string') result.connection[field] = connection[field].slice(0, 4096);
  }
  if (Number.isInteger(connection.port) && connection.port > 0 && connection.port < 65536) result.connection.port = connection.port;
  if (typeof connection.autoConnect === 'boolean') result.connection.autoConnect = connection.autoConnect;
  if (!['key', 'password', 'agent'].includes(result.connection.authType)) result.connection.authType = 'key';
  result.projects = Array.isArray(input.projects) ? input.projects.slice(0, 500) : [];
  result.conversations = Array.isArray(input.conversations) ? input.conversations.slice(0, 2000) : [];
  result.settings = input.settings && typeof input.settings === 'object' && !Array.isArray(input.settings) ? input.settings : {};
  const encoded = JSON.stringify(result);
  if (Buffer.byteLength(encoded) > 16 * 1024 * 1024) throw new Error('会话记录超过 16 MB，请删除不再需要的会话');
  return JSON.parse(encoded);
}

class StateStore {
  constructor(directory, renameOptions = {}) { this.directory = directory; this.renameOptions = renameOptions; this.queue = Promise.resolve(); }
  async read(name, fallback) {
    try { return JSON.parse(await fs.readFile(path.join(this.directory, name), 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') return fallback;
      throw new Error(`无法读取 ${name}，原文件已保留：${error.message}`);
    }
  }
  async load() { return cleanState(await this.read('workspace.json', defaults())); }
  save(state) { return this.write('workspace.json', cleanState(state)); }
  write(name, value) {
    const content = JSON.stringify(value, null, 2);
    const action = async () => {
      await fs.mkdir(this.directory, { recursive: true });
      const target = path.join(this.directory, name);
      const temp = `${target}.${crypto.randomUUID()}.tmp`;
      try { await fs.writeFile(temp, content, { mode: 0o600, flag: 'wx' }); await replaceWithRetry(temp, target, this.renameOptions); }
      finally { await fs.rm(temp, { force: true }).catch(() => {}); }
    };
    const pending = this.queue.then(action, action);
    this.queue = pending.catch(() => {});
    return pending;
  }
}

function safeFilename(remotePath) {
  let name = path.posix.basename(String(remotePath)).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[ .]+$/g, '');
  if (!name || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `download_${name || 'file'}`;
  return name.slice(0, 180);
}

async function atomicDownload(remote, remotePath, destination) {
  const temp = path.join(path.dirname(destination), `.${path.basename(destination)}.${crypto.randomUUID()}.part`);
  try {
    const result = await remote.download(remotePath, temp);
    await fs.rename(temp, destination);
    return { canceled: false, localPath: destination, bytes: result.bytes };
  } finally { await fs.rm(temp, { force: true }).catch(() => {}); }
}

module.exports = { defaults, cleanState, StateStore, safeFilename, atomicDownload };
