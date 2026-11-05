'use strict';
const net = require('node:net');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const MEDIA_LIMIT = 20 * 1024 * 1024;
function imageMime(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (/^GIF8[79]a/.test(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  return null;
}
function portNumber(value, allowZero = false) {
  if (!Number.isInteger(value) || value < (allowZero ? 0 : 1) || value > 65535) throw new Error('端口必须是 1–65535 的整数');
  return value;
}

function installRemoteFeatures(RemoteClient, shellQuote, inferenceOptions) {
  Object.assign(RemoteClient.prototype, {
    async checkInferenceOptions(options) {
      const selected = inferenceOptions(options);
      if (selected.effort) {
        const help = await this._execCapture(`export PATH="$HOME/.local/bin:$PATH"; ${shellQuote(this.claudePath)} --help`, { timeout: 15000 });
        const section = help.stdout.match(/^[ \t]*--effort\b[^\n]*(?:\n(?![ \t]*-)[ \t]+[^\n]*)*/m)?.[0] || '';
        const supported = section.match(/\b(?:low|medium|high|xhigh|max)\b/g) || [];
        if (help.code !== 0 || !supported.includes(selected.effort)) throw new Error(`远端 Claude CLI 不支持或未列出 ${selected.effort} 思考强度，请更新 CLI 或选择“跟随远端”。`);
      }
      return selected;
    },
    async readMedia(value) {
      const target = await this.resolvePath(value);
      const stat = await this._sftpCall('stat', target);
      if (!stat.isFile() || stat.size > MEDIA_LIMIT) throw new Error('预览支持 20 MB 以内的图片，请下载较大文件');
      const chunks = []; let size = 0;
      for await (const chunk of this._currentSftp().createReadStream(target)) {
        this._assertContext(); size += chunk.length;
        if (size > MEDIA_LIMIT) throw new Error('图片超过预览大小限制');
        chunks.push(chunk);
      }
      const data = Buffer.concat(chunks); const mime = imageMime(data);
      if (!mime) throw new Error('支持预览 PNG、JPEG、GIF 和 WebP 图片');
      return { path: target, mime, size, dataUrl: `data:${mime};base64,${data.toString('base64')}` };
    },
    async searchFiles({ projectPath, query = '' }) {
      const root = await this._directory(projectPath);
      if (typeof query !== 'string' || query.length > 256) throw new Error('搜索词过长');
      const found = []; const queue = [root]; let visited = 0;
      const ignored = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.cloude-attachments']);
      while (queue.length && visited < 3000 && found.length < 80) {
        const directory = queue.shift();
        for (const entry of await this.listFiles(directory)) {
          if (++visited > 3000) break;
          if (entry.type === 'symlink') continue;
          if (entry.type === 'directory') { if (!ignored.has(entry.name) && entry.path.slice(root.length).split('/').length < 9) queue.push(entry.path); }
          else if (entry.path.slice(root.length + 1).toLowerCase().includes(query.toLowerCase())) found.push(entry);
          if (found.length >= 80) break;
        }
      }
      return { files: found, truncated: queue.length > 0 || visited >= 3000 || found.length >= 80 };
    },
    async openTerminal({ jobId, projectPath, cols = 100, rows = 24, login = false }) {
      const directory = await this._directory(projectPath);
      const command = `export PATH="$HOME/.local/bin:$PATH"; cd -- ${shellQuote(directory)} && ${login ? `exec ${shellQuote(this.claudePath)} auth login` : 'exec bash -i'}`;
      const result = await this._startJob({ jobId, kind: 'terminal', command, pty: true });
      this.resizeTerminal({ jobId, cols, rows });
      return result;
    },
    resizeTerminal({ jobId, cols, rows }) {
      const job = this.jobs.get(jobId);
      if (!job?.pty || !job.channel) throw new Error('终端未连接');
      if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 1 || cols > 500 || rows > 300) throw new Error('终端尺寸无效');
      job.channel.setWindow(rows, cols, 0, 0);
    },
    async forwardPort({ remotePort, localPort = 0 }) {
      this._connected(); portNumber(remotePort); portNumber(localPort, true);
      this.tunnels ||= new Map();
      const existing = [...this.tunnels.values()].find(t => t.remotePort === remotePort && (!localPort || t.localPort === localPort));
      if (existing) return { id: existing.id, remotePort, localPort: existing.localPort, url: `http://127.0.0.1:${existing.localPort}` };
      if (this.tunnels.size >= 12) throw new Error('最多同时转发 12 个端口');
      const client = this.client; const generation = this.generation; const sockets = new Set();
      const server = net.createServer(socket => {
        if (this.client !== client || this.generation !== generation) return socket.destroy();
        sockets.add(socket); socket.on('error', () => socket.destroy()); socket.on('close', () => sockets.delete(socket));
        client.forwardOut('127.0.0.1', socket.remotePort || 0, '127.0.0.1', remotePort, (error, channel) => {
          if (error || socket.destroyed || this.client !== client) { channel?.close(); socket.destroy(); if (error) this._emit({ kind: 'tunnel', type: 'error', data: `端口 ${remotePort}：${error.message}` }); return; }
          channel.on('error', () => socket.destroy()); channel.on('close', () => socket.destroy()); socket.on('close', () => channel.destroy());
          socket.pipe(channel).pipe(socket);
        });
      });
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(localPort, '127.0.0.1', resolve); });
      server.on('error', error => this._emit({ kind: 'tunnel', type: 'error', data: error.message }));
      if (this.client !== client || this.generation !== generation) { server.close(); throw new Error('连接已变化'); }
      const id = crypto.randomUUID(); const assigned = server.address().port;
      this.tunnels.set(id, { id, server, sockets, localPort: assigned, remotePort });
      return { id, localPort: assigned, remotePort, url: `http://127.0.0.1:${assigned}` };
    },
    listPorts() { return [...(this.tunnels?.values() || [])].map(({ id, localPort, remotePort }) => ({ id, localPort, remotePort, url: `http://127.0.0.1:${localPort}` })); },
    closePort(id) { const tunnel = this.tunnels?.get(id); if (tunnel) { for (const socket of tunnel.sockets) socket.destroy(); tunnel.server.close(); this.tunnels.delete(id); } },
    closePorts() { for (const id of this.tunnels?.keys() || []) this.closePort(id); },
    async taskRequest(projectPath, action, data = {}) {
      const directory = await this._directory(projectPath);
      const helper = await fs.readFile(path.join(__dirname, 'task-runner.py'), 'utf8');
      // A poll normally holds 1 MB, but may return one complete 16 MB event.
      const result = await this._execCapture(`python3 -c ${shellQuote(helper)}`, { input: JSON.stringify({ ...data, ...(action === 'start' ? { runnerSource: helper } : {}), projectPath: directory, action }), maxBytes: 32 * 1024 * 1024, timeout: 30000 });
      let answer;
      try { answer = JSON.parse(result.stdout); } catch { throw new Error(`任务服务不可用，请确认远端有 Python 3：${result.stderr.slice(0, 500)}`); }
      if (result.code !== 0 || answer.error) throw new Error(answer.error || '远端任务操作失败');
      return answer;
    },
    async listTasks({ projectPath }) { return this.taskRequest(projectPath, 'list'); },
    async pollTask({ projectPath, jobId, cursor = 0 }) { return this.taskRequest(projectPath, 'poll', { jobId, cursor }); },
    async replyTask({ projectPath, jobId, requestId, allow, answers, scope = 'once' }) { return this.taskRequest(projectPath, 'reply', { jobId, requestId, allow, answers, scope }); },
    async stopTask({ projectPath, jobId }) { return this.taskRequest(projectPath, 'stop', { jobId }); },
    async startPersistentChat(options) {
      if (typeof options.prompt !== 'string' || !options.prompt.trim() || Buffer.byteLength(options.prompt) > 512 * 1024) throw new Error('消息为空或过长');
      if (!['plan', 'edit'].includes(options.mode)) throw new Error('权限模式无效');
      const selected = await this.checkInferenceOptions(options);
      return this.taskRequest(options.projectPath, 'start', { jobId: options.jobId, conversationId: options.conversationId,
        prompt: options.prompt, sessionId: options.sessionId, mode: options.mode, ...selected,
        executable: this.claudePath, title: options.prompt.slice(0, 80) });
    },
  });
}
module.exports = { installRemoteFeatures, imageMime, MEDIA_LIMIT, portNumber };
