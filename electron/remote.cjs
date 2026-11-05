'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const posix = path.posix;
const crypto = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { AsyncLocalStorage } = require('node:async_hooks');
const { parseUsageOutput, supportsUsageVersion, unavailable } = require('./usage.cjs');
const { inspectLocalPath, localVersion, sameLocalVersion, sameRemoteVersion } = require('./uploads.cjs');

const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_COMMAND_BYTES = 512 * 1024;
const MAX_JSON_LINE = 16 * 1024 * 1024;

function shellQuote(value) {
  const text = String(value);
  if (text.includes('\0')) throw new Error('路径或命令参数包含无效字符。');
  return "'" + text.replace(/'/g, "'\\''") + "'";
}

function isWithin(root, candidate) {
  return candidate === root || (root !== '/' && candidate.startsWith(root + '/'));
}

function expandPath(value, home, base) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || value.length > 8192) {
    throw new Error('请输入有效的远程路径。');
  }
  let expanded = value;
  if (value === '~') expanded = home;
  else if (value.startsWith('~/')) expanded = posix.join(home, value.slice(2));
  else if (value.startsWith('~')) throw new Error('只支持当前用户的 ~/ 路径。');
  return posix.resolve(base || home, expanded);
}

function isMissing(error) { return error && (error.code === 2 || error.code === 'ENOENT'); }
function hashText(content) { return crypto.createHash('sha256').update(content).digest('hex'); }
function assertString(value, name, max = MAX_COMMAND_BYTES) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || Buffer.byteLength(value) > max) {
    throw new Error(`${name}为空、过长或包含无效字符。`);
  }
  return value;
}

// SSH stdout may split both JSON lines and individual UTF-8 characters.
class JsonLines {
  constructor(onJson, onText) {
    this.decoder = new StringDecoder('utf8');
    this.pending = '';
    this.onJson = onJson;
    this.onText = onText;
  }
  push(chunk) { this.consume(this.decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))); }
  consume(text) {
    this.pending += text;
    if (this.pending.length > MAX_JSON_LINE) throw new Error('Claude 返回了过大的单条消息，已停止读取。');
    let next;
    while ((next = this.pending.indexOf('\n')) !== -1) {
      const line = this.pending.slice(0, next).trim();
      this.pending = this.pending.slice(next + 1);
      this.line(line);
    }
  }
  line(line) {
    if (!line) return;
    try { this.onJson(JSON.parse(line)); }
    catch (error) {
      if (error instanceof SyntaxError) this.onText(line + '\n');
      else throw error;
    }
  }
  end() { this.consume(this.decoder.end()); this.line(this.pending.trim()); this.pending = ''; }
}

const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
function inferenceOptions({ model, effort }) {
  if (model !== undefined && model !== '') {
    assertString(model, '模型', 120);
    if (/[\x00-\x20\x7f]/.test(model)) throw new Error('模型 ID 不能包含空白或控制字符。');
  }
  if (effort !== undefined && effort !== '' && !EFFORT_LEVELS.includes(effort)) throw new Error('未知的思考强度。');
  return { ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
}

function claudeCommand({ executable, projectPath, sessionId, mode, model, effort }) {
  if (!['plan', 'edit'].includes(mode)) throw new Error('未知的 Claude 权限模式。');
  assertString(executable, 'Claude 可执行文件', 4096);
  inferenceOptions({ model, effort });
  const args = [executable, '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
  // Omit overrides so the CLI loads the same permission settings as the TUI.
  if (mode === 'plan') args.push('--permission-mode', 'plan');
  if (sessionId) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(sessionId)) throw new Error('会话 ID 无效。');
    args.push('--resume', sessionId);
  }
  if (model) args.push('--model', assertString(model, '模型', 120));
  if (effort) args.push('--effort', effort);
  // Claude's effort environment variable outranks --effort; an explicit UI
  // selection overrides it for this child only. Inherit both when unset.
  return `export PATH="$HOME/.local/bin:$PATH"; export CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1; ${effort ? `export CLAUDE_CODE_EFFORT_LEVEL=${shellQuote(effort)}; ` : ''}cd -- ${shellQuote(projectPath)} && exec ${args.map(shellQuote).join(' ')}`;
}

function usageCommand(executable, directory) {
  assertString(executable, 'Claude 可执行文件', 4096);
  assertString(directory, '账户查询目录', 8192);
  const args = [executable, '-p', '/usage', '--output-format', 'stream-json', '--verbose',
    '--no-session-persistence', '--max-turns', '1', '--tools', '',
    '--settings', '{"disableAllHooks":true}', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'];
  return `export PATH="$HOME/.local/bin:$PATH"; export CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1; cd -- ${shellQuote(directory)} && exec ${args.map(shellQuote).join(' ')}`;
}

class RemoteClient {
  constructor({ emit = () => {}, verifyHost = async () => false, clientFactory } = {}) {
    this.emit = emit;
    this.verifyHost = verifyHost;
    this.clientFactory = clientFactory || (() => new (require('ssh2').Client)());
    this.client = null;
    this.sftp = null;
    this.home = '';
    this.workspace = '';
    this.workspaceInput = '';
    this.projectRoots = new Set();
    this.projectAliases = new Map();
    this.claudePath = 'claude';
    this.claudeVersion = '';
    this.usageCache = null;
    this.usageFlight = null;
    this.jobs = new Map();
    this.readVersions = new Map();
    this.generation = 0;
    this.connecting = false;
    this.operationContext = new AsyncLocalStorage();
  }

  _emit(event) { try { this.emit(event); } catch { /* Renderer lifetime does not own SSH lifetime. */ } }
  _assertContext() {
    const active = this.operationContext.getStore();
    if (active && (active.generation !== this.generation || active.sftp !== this.sftp)) throw new Error('连接已发生变化，操作已取消，请在当前设备上重试。');
  }
  _connected() { this._assertContext(); if (!this.client || !this.sftp) throw new Error('尚未连接设备，请先连接设备。'); }
  _currentSftp() { this._connected(); return this.sftp; }
  _sftpCall(method, ...args) {
    try { this._assertContext(); } catch (error) { return Promise.reject(error); }
    const sftp = this.sftp;
    if (!sftp) return Promise.reject(new Error('SFTP 连接已断开。'));
    return new Promise((resolve, reject) => {
      try { sftp[method](...args, (error, result) => {
        try { this._assertContext(); } catch (changed) { reject(changed); return; }
        error ? reject(error) : resolve(result);
      }); }
      catch (error) { reject(error); }
    });
  }

  async connect(config) {
    if (this.connecting) throw new Error('正在连接，请稍候。');
    if (!config || typeof config !== 'object') throw new Error('连接配置无效。');
    const host = assertString(config.host, '主机名', 253);
    const username = assertString(config.username, '用户名', 128);
    const port = Number(config.port || 22);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SSH 端口必须介于 1 和 65535。');
    if (!['key', 'password', 'agent'].includes(config.authType)) throw new Error('请选择有效的认证方式。');
    const requestedRoot = assertString(config.workspace || '~/claude-workspace', '工作目录', 4096);
    const executable = assertString(config.claudePath || 'claude', 'Claude 可执行文件', 4096);
    await this.disconnect();
    this.projectRoots.clear(); this.projectAliases.clear();
    this.connecting = true;
    const generation = ++this.generation;
    const client = this.clientFactory();
    this.client = client;
    const options = {
      host, port, username, readyTimeout: 90000, keepaliveInterval: 10000, keepaliveCountMax: 3,
      hostVerifier: (key, callback) => {
        const fingerprint = 'SHA256:' + crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
        Promise.resolve(this.verifyHost({ host, port, fingerprint })).then(
          (trusted) => callback(trusted === true && generation === this.generation), () => callback(false));
      },
    };
    try {
      if (config.authType === 'password') options.password = assertString(config.password, '密码', 16384);
      else if (config.authType === 'key') {
        const keyPath = assertString(config.privateKeyPath, '私钥路径', 8192);
        const stat = await fsp.stat(keyPath);
        if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('私钥文件无效或过大。');
        options.privateKey = await fsp.readFile(keyPath);
        if (config.passphrase) options.passphrase = String(config.passphrase);
      } else options.agent = process.env.SSH_AUTH_SOCK || (process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : undefined);
      if (config.authType === 'agent' && !options.agent) throw new Error('未找到 SSH Agent，请选择私钥文件或密码认证。');

      await new Promise((resolve, reject) => {
        const onError = error => { cleanup(); reject(error); };
        const onClose = () => { cleanup(); reject(new Error('SSH 连接在认证完成前关闭。')); };
        const cleanup = () => { client.off('error', onError); client.off('close', onClose); };
        client.once('ready', () => { cleanup(); resolve(); });
        client.once('error', onError);
        client.once('close', onClose);
        // A permanent error handler prevents uncaught errors after handshake.
        client.on('error', error => {
          if (this.sftp && this.client === client) this._emit({ kind: 'connection', status: 'error', message: error.message });
        });
        client.on('close', () => {
          if (this.client !== client) return;
          this.client = null; this.sftp = null;
          this._finishLostJobs();
          this._emit({ kind: 'connection', status: 'disconnected', message: 'SSH 已断开；远端任务是否停止需要重新连接后确认。' });
        });
        client.connect(options);
      });
      if (generation !== this.generation) throw new Error('连接已取消。');
      this.sftp = await new Promise((resolve, reject) => client.sftp((error, sftp) => error ? reject(error) : resolve(sftp)));
      this.sftp.on('error', error => this._emit({ kind: 'connection', status: 'error', message: 'SFTP: ' + error.message }));
      this.home = await this._sftpCall('realpath', '.');
      this.workspaceInput = expandPath(requestedRoot, this.home, this.home);
      if (this.workspaceInput === '/') throw new Error('请使用专用项目目录，不要把 / 设为工作目录。');
      await this._mkdirRecursiveUnscoped(this.workspaceInput);
      this.workspace = await this._sftpCall('realpath', this.workspaceInput);
      this.claudePath = executable.startsWith('~/') ? expandPath(executable, this.home, this.home) : executable;
      const info = await this._execCapture(`export PATH="$HOME/.local/bin:$PATH"; hostname; ${shellQuote(this.claudePath)} --version`, { maxBytes: 32768, timeout: 15000 });
      const lines = info.stdout.trim().split(/\r?\n/);
      const hostname = lines.shift() || host;
      const claudeVersion = lines.join('\n').trim();
      if (generation !== this.generation) throw new Error('连接已取消。');
      this.claudeVersion = info.code === 0 ? claudeVersion : '';
      return { home: this.home, workspace: this.workspace, hostname, claudeVersion: info.code === 0 ? claudeVersion : '', claudeAvailable: info.code === 0 && !!claudeVersion };
    } catch (error) {
      if (this.client === client) { this.client = null; this.sftp = null; }
      client.end();
      throw new Error(`连接失败：${error.message}`);
    } finally {
      // ssh2 retains authentication for its live connection; app state never retains these values.
      if (options.privateKey) options.privateKey.fill(0);
      delete options.privateKey; delete options.password; delete options.passphrase;
      this.connecting = false;
    }
  }

  async disconnect() {
    this.closePorts();
    ++this.generation;
    this.usageCache = null; this.usageFlight = null; this.claudeVersion = '';
    const client = this.client;
    if (!client) return;
    for (const job of this.jobs.values()) {
      try { if (job.pty) job.channel.write('\x03'); job.channel.signal('TERM'); } catch {}
    }
    this.client = null; this.sftp = null;
    this._finishLostJobs();
    client.end();
    this.readVersions.clear();
    this._emit({ kind: 'connection', status: 'disconnected', message: '已断开 SSH。已请求停止活动任务；没有远端退出确认时，不能确认程序已停止。' });
  }

  _finishLostJobs() {
    this.closePorts();
    for (const job of [...this.jobs.values()]) {
      job.emit({ type: 'error', data: '连接中断，远端任务状态未知；重连不会自动重复执行任务。' });
      job.finish(null, 'CONNECTION_LOST');
    }
    this.jobs.clear();
  }

  async _mkdirRecursiveUnscoped(directory) {
    const normalized = posix.resolve(directory);
    let cursor = '/';
    for (const segment of normalized.split('/').filter(Boolean)) {
      cursor = posix.join(cursor, segment);
      try {
        const stats = await this._sftpCall('stat', cursor);
        if (!stats.isDirectory()) throw new Error(`${cursor} 不是目录。`);
      } catch (error) {
        if (!isMissing(error)) throw error;
        try { await this._sftpCall('mkdir', cursor, { mode: 0o700 }); }
        catch (mkdirError) {
          // Another process may have created the same directory.
          const stats = await this._sftpCall('stat', cursor).catch(() => null);
          if (!stats || !stats.isDirectory()) throw mkdirError;
        }
      }
    }
  }

  _requestedPath(value) {
    let requested = expandPath(value, this.home, this.workspace);
    if (this.workspaceInput !== this.workspace && isWithin(this.workspaceInput, requested)) {
      requested = this.workspace + requested.slice(this.workspaceInput.length);
    }
    for (const [alias, actual] of [...this.projectAliases].sort((a, b) => b[0].length - a[0].length)) {
      if (isWithin(alias, requested)) return actual + requested.slice(alias.length);
    }
    return requested;
  }

  _accessRoot(value) {
    return [this.workspace, ...this.projectRoots].filter(root => isWithin(root, value)).sort((a, b) => b.length - a.length)[0];
  }

  async openProject(value) {
    this._connected();
    const requested = expandPath(value, this.home, this.home);
    const actual = await this._sftpCall('realpath', requested);
    if (actual === '/' || !(await this._sftpCall('stat', actual)).isDirectory()) throw new Error('请选择已有的项目文件夹。');
    this._assertContext();
    this.projectRoots.add(actual); this.projectAliases.set(requested, actual);
    return { path: actual, name: posix.basename(actual) };
  }

  async _readProjectSessions(projectPath, operation, sessionId = '') {
    const directory = await this._directory(projectPath);
    if (sessionId && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(sessionId)) throw new Error('会话 ID 无效。');
    const reader = await fsp.readFile(path.join(__dirname, 'session-reader.py'), 'utf8');
    const command = ['python3', '-c', reader, directory, operation, sessionId].map(shellQuote).join(' ');
    const result = await this._execCapture(command, { maxBytes: 2 * 1024 * 1024, timeout: 30000 });
    let data;
    try { data = JSON.parse(result.stdout.trim()); } catch { throw new Error('无法读取历史对话，请检查 远程设备上的 Python 3 和 Claude 会话目录。'); }
    if (result.code !== 0 || data.error) throw new Error(data.error || '历史对话读取失败。');
    return data;
  }

  async listSessions(projectPath) { return this._readProjectSessions(projectPath, 'list'); }
  async readSession(projectPath, sessionId) { return this._readProjectSessions(projectPath, 'read', sessionId); }

  async resolvePath(value, { allowMissing = false } = {}) {
    this._connected();
    const requested = this._requestedPath(value);
    if (!this._accessRoot(requested)) throw new Error('文件操作只能位于工作目录或已打开的项目内。');
    try {
      const actual = await this._sftpCall('realpath', requested);
      if (!this._accessRoot(actual)) throw new Error('该符号链接指向工作目录外，无法访问。');
      // Some SFTP servers realpath nonexistent paths; lstat makes existence explicit.
      await this._sftpCall('lstat', actual);
      return actual;
    } catch (error) {
      if (!allowMissing || !isMissing(error)) throw error;
      const entry = await this._sftpCall('lstat', requested).catch(err => {
        if (!isMissing(err)) throw err;
        return null;
      });
      if (entry) throw new Error('目标路径无法解析，请检查符号链接。');
      const parent = await this._sftpCall('realpath', posix.dirname(requested));
      if (!this._accessRoot(parent)) throw new Error('目标目录位于工作目录外。');
      const stats = await this._sftpCall('stat', parent);
      if (!stats.isDirectory()) throw new Error('目标父路径不是目录。');
      return posix.join(parent, posix.basename(requested));
    }
  }

  async _directory(value) {
    const resolved = await this.resolvePath(value);
    if (!(await this._sftpCall('stat', resolved)).isDirectory()) throw new Error('所选路径不是目录。');
    return resolved;
  }

  async listFiles(value) {
    const directory = await this._directory(value);
    const entries = await this._sftpCall('readdir', directory);
    return entries.filter(entry => entry.filename !== '.' && entry.filename !== '..')
      .map(({ filename, attrs }) => ({ name: filename, path: posix.join(directory, filename),
        type: attrs.isSymbolicLink() ? 'symlink' : attrs.isDirectory() ? 'directory' : 'file', size: attrs.size, mtime: attrs.mtime }))
      .sort((a, b) => (a.type === 'directory' ? 0 : 1) - (b.type === 'directory' ? 0 : 1) || a.name.localeCompare(b.name));
  }

  async _readBuffer(remotePath, stats) {
    if (!stats.isFile()) throw new Error('只能打开普通文件。');
    if (stats.size > MAX_TEXT_BYTES) throw new Error('文件超过 2 MB，请使用下载按钮在 Windows 中打开。');
    const stream = this._currentSftp().createReadStream(remotePath);
    const chunks = []; let size = 0;
    for await (const chunk of stream) {
      size += chunk.length;
      if (size > MAX_TEXT_BYTES) { stream.destroy(); throw new Error('文件过大，请下载后打开。'); }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  async readFile(value) {
    const remotePath = await this.resolvePath(value);
    const stats = await this._sftpCall('stat', remotePath);
    const buffer = await this._readBuffer(remotePath, stats);
    if (buffer.includes(0)) throw new Error('这是二进制文件，请使用“下载到 Windows”。');
    const content = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    const after = await this._sftpCall('stat', remotePath);
    if (after.size !== stats.size || after.mtime !== stats.mtime) throw new Error('读取期间文件发生变化，请重新打开。');
    this.readVersions.set(remotePath, { mtime: after.mtime, hash: hashText(buffer) });
    if (this.readVersions.size > 200) this.readVersions.delete(this.readVersions.keys().next().value);
    return { content, mtime: after.mtime, size: buffer.length };
  }

  async _replace(temp, target) {
    // OpenSSH's extension is an atomic replacement. Never delete the old file first.
    try { await this._sftpCall('ext_openssh_rename', temp, target); }
    catch (error) {
      if (!(error.code === 8 || /unsupported|not supported|not a function/i.test(error.message))) throw error;
      try { await this._sftpCall('rename', temp, target); }
      catch { throw new Error('服务器不支持安全替换文件，原文件已保留；请另存为新文件。'); }
    }
  }

  async saveFile(value, content, expectedMtime) {
    if (typeof content !== 'string' || Buffer.byteLength(content) > MAX_TEXT_BYTES || content.includes('\0')) throw new Error('仅支持保存 2 MB 以内的文本文件。');
    const remotePath = await this.resolvePath(value, { allowMissing: true });
    if (expectedMtime === null) {
      if (content !== '') throw new Error('新建操作只能创建空文件，请创建后再编辑保存。');
      // Exclusive OPEN is the atomic existence check; never unlink on failure,
      // because a failing OPEN may mean another process created this filename.
      try { await this._sftpCall('writeFile', remotePath, Buffer.alloc(0), { flag: 'wx', mode: 0o600 }); }
      catch (error) {
        if (error.code === 4 || error.code === 'EEXIST') throw new Error('无法新建：同名文件已存在或没有写入权限，请刷新文件列表。');
        throw error;
      }
      const created = await this._sftpCall('stat', remotePath);
      this.readVersions.set(remotePath, { mtime: created.mtime, hash: hashText('') });
      return { mtime: created.mtime, size: created.size };
    }
    let stats = await this._sftpCall('stat', remotePath).catch(error => { if (!isMissing(error)) throw error; return null; });
    if (stats && !stats.isFile()) throw new Error('目标不是普通文件。');
    const previous = this.readVersions.get(remotePath);
    const check = async () => {
      const current = await this._sftpCall('stat', remotePath).catch(error => { if (!isMissing(error)) throw error; return null; });
      if (expectedMtime !== undefined && (!current || current.mtime !== expectedMtime)) throw new Error('文件已被其他操作修改或删除，请重新打开后再保存。');
      if (current && expectedMtime !== undefined && previous && previous.mtime === expectedMtime) {
        const buffer = await this._readBuffer(remotePath, current);
        if (hashText(buffer) !== previous.hash) throw new Error('文件内容已在远端修改，请重新打开后再保存。');
      }
      return current;
    };
    stats = await check();
    const temp = posix.join(posix.dirname(remotePath), '.workspace-save-' + crypto.randomUUID());
    try {
      await this._sftpCall('writeFile', temp, Buffer.from(content), { flag: 'wx', mode: stats ? stats.mode & 0o777 : 0o600 });
      await check();
      await this._replace(temp, remotePath);
      const result = await this._sftpCall('stat', remotePath);
      this.readVersions.set(remotePath, { mtime: result.mtime, hash: hashText(content) });
      return { mtime: result.mtime, size: result.size };
    } catch (error) {
      await this._sftpCall('unlink', temp).catch(() => {});
      throw error;
    }
  }

  async mkdir(value) {
    const directory = await this.resolvePath(value, { allowMissing: true });
    const existing = await this._sftpCall('stat', directory).catch(error => { if (!isMissing(error)) throw error; return null; });
    if (existing) { if (!existing.isDirectory()) throw new Error('已有同名文件。'); return { path: directory }; }
    await this._sftpCall('mkdir', directory, { mode: 0o700 });
    return { path: directory };
  }

  async _uploadTarget(value, allowMissingParents = false) {
    this._connected();
    const requested = this._requestedPath(value);
    const root = this._accessRoot(requested);
    if (!root) throw new Error('上传目标必须位于工作目录或已打开的项目内。');
    if (await this._sftpCall('realpath', root) !== root) throw new Error('工作目录已变成符号链接，请重新连接后检查。');
    let cursor = root;
    let stats = await this._sftpCall('lstat', cursor);
    if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error('上传工作目录已发生变化。');
    const segments = posix.relative(root, requested).split('/').filter(Boolean);
    for (let index = 0; index < segments.length; index++) {
      cursor = posix.join(cursor, segments[index]);
      stats = await this._sftpCall('lstat', cursor).catch(error => {
        if (isMissing(error)) return null;
        throw error;
      });
      if (!stats) {
        if (allowMissingParents || index === segments.length - 1) return { path: requested, stats: null };
        throw new Error(`上传父目录已不存在：${cursor}`);
      }
      if (stats.isSymbolicLink()) throw new Error(`上传目标包含符号链接，无法写入：${cursor}`);
      if (index < segments.length - 1 && !stats.isDirectory()) throw new Error(`上传父路径不是目录：${cursor}`);
    }
    return { path: requested, stats };
  }

  async inspectUploadPath(value) {
    const target = await this._uploadTarget(value, true);
    if (!target.stats) return null;
    const stats = target.stats;
    return { path: target.path, type: stats.isDirectory() ? 'directory' : stats.isFile() ? 'file' : 'other', size: stats.size, mtime: stats.mtime, mode: stats.mode };
  }

  async mkdirUploadDirectory(value) {
    const target = await this._uploadTarget(value);
    if (target.stats && !target.stats.isDirectory()) throw new Error(`已有同名文件，无法创建上传目录：${target.path}`);
    if (!target.stats) {
      try { await this._sftpCall('mkdir', target.path, { mode: 0o700 }); }
      catch (error) {
        const current = await this._uploadTarget(target.path);
        if (!current.stats?.isDirectory()) throw error;
      }
    }
    const current = await this._uploadTarget(target.path);
    if (!current.stats?.isDirectory()) throw new Error('上传目录在创建期间发生变化，请重试。');
    return { path: current.path };
  }

  _progress(direction, name, total, onProgress) {
    let transferred = 0; let last = 0;
    const report = () => {
      this._emit({ kind: 'transfer', direction, name, transferred, total });
      onProgress?.({ transferred, total });
    };
    report();
    const stream = new Transform({ transform(chunk, encoding, callback) {
      transferred += chunk.length;
      if (Date.now() - last > 100) { last = Date.now(); report(); }
      callback(null, chunk);
    } });
    return { stream, get bytes() { return transferred; }, report };
  }

  async download(value, localPath) {
    const remotePath = await this.resolvePath(value);
    const stats = await this._sftpCall('stat', remotePath);
    if (!stats.isFile()) throw new Error('请选择文件下载；文件夹请先在 远程设备上打包。');
    const destination = path.resolve(assertString(localPath, '保存位置', 32768));
    const temp = destination + '.workspace-' + crypto.randomUUID() + '.partial';
    const progress = this._progress('download', posix.basename(remotePath), stats.size);
    try {
      await pipeline(this._currentSftp().createReadStream(remotePath), progress.stream, fs.createWriteStream(temp, { flags: 'wx' }));
      const after = await this._sftpCall('stat', remotePath);
      if (progress.bytes !== stats.size || after.size !== stats.size || after.mtime !== stats.mtime) throw new Error('下载期间远端文件发生变化，未替换本地文件，请重试。');
      await fsp.rename(temp, destination);
      progress.report();
      return { bytes: progress.bytes };
    } catch (error) { await fsp.unlink(temp).catch(() => {}); throw error; }
  }

  async upload(localPath, remoteDirectory, { overwrite = false, expectedLocal, expectedRemote, onProgress } = {}) {
    const parent = await this._uploadTarget(remoteDirectory);
    if (!parent.stats?.isDirectory()) throw new Error('上传目标文件夹不存在。');
    const directory = parent.path;
    const local = path.resolve(assertString(localPath, '上传文件', 32768));
    const stats = await inspectLocalPath(local);
    if (!stats.isFile()) throw new Error('只能上传普通文件。');
    if (expectedLocal && !sameLocalVersion(localVersion(stats), expectedLocal)) throw new Error('本地文件在确认后发生变化，请重新上传。');
    const remotePath = posix.join(directory, path.basename(local));
    const existing = await this.inspectUploadPath(remotePath);
    if (existing && existing.type !== 'file') throw new Error('已有同名目录或符号链接，无法覆盖。');
    if (existing && overwrite !== true) throw new Error(`远端已有 ${path.basename(local)}，请重命名后上传，以免覆盖文件。`);
    if (expectedRemote !== undefined && !sameRemoteVersion(existing, expectedRemote)) throw new Error('远端文件在确认后发生变化，请重新上传并确认覆盖。');
    const temp = posix.join(directory, '.workspace-upload-' + crypto.randomUUID());
    const progress = this._progress('upload', path.basename(local), stats.size, onProgress);
    let source;
    try {
      source = await fsp.open(local, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const opened = await source.stat();
      if (!opened.isFile() || !sameLocalVersion(localVersion(opened), localVersion(stats))) throw new Error('本地文件在打开时发生变化，请重试。');
      await this._uploadTarget(temp);
      await pipeline(source.createReadStream({ autoClose: false }), progress.stream, this._currentSftp().createWriteStream(temp, { flags: 'wx', mode: existing ? existing.mode & 0o777 : 0o600 }));
      onProgress?.({ phase: 'committing', transferred: progress.bytes, total: stats.size });
      const after = await inspectLocalPath(local);
      const openedAfter = await source.stat();
      if (progress.bytes !== stats.size || !sameLocalVersion(localVersion(after), localVersion(stats)) || !sameLocalVersion(localVersion(openedAfter), localVersion(stats))) throw new Error('上传期间本地文件发生变化，请重试。');
      const current = await this.inspectUploadPath(remotePath);
      if (current && current.type !== 'file') throw new Error('上传期间目标变成目录或符号链接，已取消。');
      if (!sameRemoteVersion(existing, current)) throw new Error('上传期间远端文件发生变化，已取消替换，请重试。');
      if (overwrite === true) await this._replace(temp, remotePath);
      else await this._sftpCall('rename', temp, remotePath);
      progress.report();
      return remotePath;
    } catch (error) {
      await this._uploadTarget(temp).then(() => this._sftpCall('unlink', temp)).catch(() => {});
      throw error;
    } finally { if (source) await source.close().catch(() => {}); }
  }

  _execCapture(command, { maxBytes = 4 * 1024 * 1024, timeout = 20000, input } = {}) {
    this._assertContext();
    const client = this.client;
    if (!client) return Promise.reject(new Error('SSH 未连接。'));
    return new Promise((resolve, reject) => {
      client.exec('bash -lc ' + shellQuote(command), (error, channel) => {
        if (error) return reject(error);
        let bytes = 0, stdout = '', stderr = '', settled = false, code = null;
        const outDecoder = new StringDecoder('utf8'); const errDecoder = new StringDecoder('utf8');
        const timer = setTimeout(() => fail(new Error('远程命令响应超时。')), timeout);
        const fail = error => { if (settled) return; settled = true; clearTimeout(timer); channel.close(); reject(error); };
        channel.on('data', chunk => { bytes += chunk.length; if (bytes > maxBytes) return fail(new Error('远程输出过大，请缩小范围。')); stdout += outDecoder.write(chunk); });
        channel.stderr.on('data', chunk => { bytes += chunk.length; if (bytes > maxBytes) return fail(new Error('远程输出过大。')); stderr += errDecoder.write(chunk); });
        channel.on('error', fail);
        channel.on('exit', exitCode => { code = exitCode; });
        channel.on('close', exitCode => {
          if (settled) return; settled = true; clearTimeout(timer);
          stdout += outDecoder.end(); stderr += errDecoder.end();
          resolve({ stdout, stderr, code: typeof exitCode === 'number' ? exitCode : code });
        });
        channel.end(input);
      });
    });
  }

  async getDiff(projectPath) {
    const directory = await this._directory(projectPath);
    const result = await this._execCapture(`export GIT_OPTIONAL_LOCKS=0; cd -- ${shellQuote(directory)} && git -c core.fsmonitor=false rev-parse --is-inside-work-tree >/dev/null 2>&1 && { git -c core.fsmonitor=false --no-pager diff --no-ext-diff --no-textconv -- .; git -c core.fsmonitor=false --no-pager diff --no-ext-diff --no-textconv --cached -- .; git -c core.fsmonitor=false status --short -- .; }`);
    return { isGit: result.code === 0, diff: result.code === 0 ? result.stdout : '' };
  }

  async getUsage() {
    this._connected();
    const generation = this.generation;
    if (!supportsUsageVersion(this.claudeVersion)) {
      return unavailable('此工作台的额度查询需要 Claude Code 2.1.314 或更新版本，请先在 远程设备上检查 Claude 版本。');
    }
    if (this.usageCache?.generation === generation && Date.now() - this.usageCache.at < 30000) return this.usageCache.result;
    if (this.usageFlight?.generation === generation) return this.usageFlight.promise;
    const flight = { generation, promise: null };
    flight.promise = (async () => {
      const output = await this._execCapture(usageCommand(this.claudePath, this.home), { maxBytes: 512 * 1024, timeout: 20000 });
      this._connected();
      if (generation !== this.generation) throw new Error('连接已变化，已丢弃旧设备的额度数据。');
      const result = output.code === 0 ? parseUsageOutput(output.stdout) : unavailable('远程设备上的 Claude 未能完成额度查询，请确认账户登录状态后重试。');
      if (result.available) this.usageCache = { generation, at: Date.now(), result };
      return result;
    })();
    this.usageFlight = flight;
    try { return await flight.promise; }
    finally { if (this.usageFlight === flight) this.usageFlight = null; }
  }

  async _startJob({ jobId, conversationId, kind, command, input, pty }) {
    this._connected();
    assertString(jobId, '任务 ID', 128);
    if (this.jobs.has(jobId)) throw new Error('任务 ID 已在运行，请勿重复提交。');
    if (this.jobs.size >= 8) throw new Error('最多同时运行 8 个任务，请先停止部分任务。');
    if (kind === 'chat' && [...this.jobs.values()].some(job => job.conversationId === conversationId)) throw new Error('该聊天仍在执行任务，请等待完成或停止后再发送。');
    const client = this.client;
    // Reserve ID before asynchronous exec so simultaneous calls cannot duplicate it.
    const job = { jobId, conversationId, kind, channel: null, pty, stopped: false, timers: [], finish: () => {}, emit: data => this._emit({ kind, jobId, ...(conversationId ? { conversationId } : {}), ...data }) };
    this.jobs.set(jobId, job);
    return new Promise((resolve, reject) => {
      client.exec('bash -lc ' + shellQuote(command), pty ? { pty: { term: 'xterm-256color', cols: 120, rows: 32 } } : {}, (error, channel) => {
        if (error || client !== this.client) { this.jobs.delete(jobId); if (channel) channel.close(); return reject(error || new Error('连接已断开。')); }
        job.channel = channel;
        let ended = false; let exitCode = null; let exitSignal = null;
        const outDecoder = new StringDecoder('utf8'); const errDecoder = new StringDecoder('utf8');
        const parser = kind === 'chat' ? new JsonLines(event => job.emit({ type: 'event', event }), data => job.emit({ type: 'stderr', data })) : null;
        job.finish = (code, signal) => {
          if (ended) return; ended = true;
          for (const timer of job.timers) clearTimeout(timer);
          this.jobs.delete(jobId);
          try { if (parser) parser.end(); else { const data = outDecoder.end(); if (data) job.emit({ type: 'data', data }); } } catch (error) { job.emit({ type: 'error', data: error.message }); }
          const rest = errDecoder.end(); if (rest) job.emit({ type: kind === 'chat' ? 'stderr' : 'data', data: rest });
          job.emit({ type: 'exit', code, signal, stopped: job.stopped });
        };
        channel.on('data', chunk => {
          if (ended) return;
          try { if (parser) parser.push(chunk); else job.emit({ type: 'data', data: outDecoder.write(chunk) }); }
          catch (error) { job.emit({ type: 'error', data: error.message }); channel.close(); job.finish(null, 'PROTOCOL_ERROR'); }
        });
        channel.stderr.on('data', chunk => { if (!ended) job.emit({ type: kind === 'chat' ? 'stderr' : 'data', data: errDecoder.write(chunk) }); });
        channel.on('error', error => { if (!ended) job.emit({ type: 'error', data: error.message }); job.finish(null, 'CHANNEL_ERROR'); });
        channel.on('exit', (code, signal) => { exitCode = code; exitSignal = signal; });
        channel.on('close', (code, signal) => job.finish(typeof code === 'number' ? code : exitCode, signal || exitSignal));
        if (input !== undefined) channel.end(input);
        resolve({ jobId });
      });
    });
  }

  async startChat(options) {
    assertString(options.prompt, '消息');
    assertString(options.conversationId, '聊天 ID', 128);
    await this.checkInferenceOptions(options);
    const directory = await this._directory(options.projectPath);
    const command = claudeCommand({ ...options, executable: this.claudePath, projectPath: directory });
    return this._startJob({ ...options, kind: 'chat', command, input: options.prompt, pty: false });
  }

  async runCommand(options) {
    const directory = await this._directory(options.projectPath);
    assertString(options.command, '命令');
    const command = `export PATH="$HOME/.local/bin:$PATH"; export PYTHONUNBUFFERED=1; cd -- ${shellQuote(directory)} && {\n${options.command}\n}`;
    return this._startJob({ ...options, kind: 'terminal', command, pty: true });
  }

  async writeJob(jobId, data) {
    const job = this.jobs.get(jobId);
    if (!job || !job.channel) throw new Error('任务未在运行。');
    if (job.kind !== 'terminal') throw new Error('聊天消息请通过聊天输入框发送。');
    if (typeof data !== 'string' || Buffer.byteLength(data) > 64 * 1024) throw new Error('终端输入过长。');
    job.channel.write(data);
  }

  async stopJob(jobId) {
    const job = this.jobs.get(jobId);
    if (!job || !job.channel) throw new Error('任务已结束或不存在。');
    if (job.stopped) return;
    job.stopped = true;
    try { if (job.pty) job.channel.write('\x03'); job.channel.signal('INT'); } catch {}
    job.timers.push(setTimeout(() => { if (this.jobs.has(jobId)) { try { job.channel.signal('TERM'); } catch {} } }, 2000));
    job.timers.push(setTimeout(() => {
      if (!this.jobs.has(jobId)) return;
      job.emit({ type: 'error', data: '远端没有确认退出，已关闭任务通道；程序可能仍在 远程设备上运行，请重新检查。' });
      job.channel.close(); job.finish(null, 'STOP_UNCONFIRMED');
    }, 6000));
  }
}

// Every public asynchronous operation stays bound to the connection it began on.
require('./remote-features.cjs').installRemoteFeatures(RemoteClient, shellQuote, inferenceOptions);
// This also protects library callers independently of the desktop's busy-operation UI.
for (const method of ['readMedia', 'searchFiles', 'openTerminal', 'forwardPort', 'taskRequest', 'listTasks', 'pollTask', 'replyTask', 'stopTask', 'startPersistentChat', 'openProject', 'listSessions', 'readSession', 'resolvePath', 'listFiles', 'readFile', 'saveFile', 'mkdir', 'inspectUploadPath', 'mkdirUploadDirectory', 'download', 'upload', 'getDiff', 'getUsage', 'startChat', 'runCommand']) {
  const implementation = RemoteClient.prototype[method];
  RemoteClient.prototype[method] = function (...args) {
    if (this.operationContext.getStore()) return implementation.apply(this, args);
    return this.operationContext.run({ generation: this.generation, sftp: this.sftp }, () => implementation.apply(this, args));
  };
}

module.exports = { RemoteClient, shellQuote, isWithin, expandPath, JsonLines, claudeCommand, usageCommand, inferenceOptions, MAX_TEXT_BYTES };
