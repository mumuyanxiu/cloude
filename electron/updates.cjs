const { EventEmitter } = require('node:events');

// Keep update policy independent of Electron so failures and retries can be tested.
class UpdateService extends EventEmitter {
  constructor({ updater, version, supported, prepareInstall = async () => {} }) {
    super();
    this.updater = updater;
    this.prepareInstall = prepareInstall;
    this.state = { status: supported ? 'idle' : 'unsupported', currentVersion: version, version: null, percent: 0, message: '' };
    this.pending = null;
    this.installing = false;
    if (!supported) return;
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.allowDowngrade = false;
    updater.allowPrerelease = false;
    updater.on('update-available', info => this.set({ status: 'available', version: info.version, percent: 0, message: '' }));
    updater.on('update-not-available', () => this.set({ status: 'latest', message: '' }));
    updater.on('download-progress', info => this.set({ status: 'downloading', percent: Math.max(0, Math.min(100, info.percent || 0)) }));
    updater.on('update-downloaded', info => this.set({ status: 'downloaded', version: info.version, percent: 100, message: '' }));
    updater.on('error', error => this.failed(error));
  }
  snapshot() { return { ...this.state }; }
  set(value) { Object.assign(this.state, value); this.emit('change', this.snapshot()); }
  failed(error) { this.set({ status: 'error', message: `更新失败，请重试：${error.message || String(error)}` }); }
  async run(status, action) {
    if (this.pending) { await this.pending; return this.snapshot(); }
    this.set({ status, message: '' });
    this.pending = Promise.resolve().then(action).catch(error => this.failed(error)).finally(() => { this.pending = null; });
    await this.pending;
    return this.snapshot();
  }
  async check() {
    if (['unsupported', 'downloaded'].includes(this.state.status)) return this.snapshot();
    return this.run('checking', () => this.updater.checkForUpdates());
  }
  async download() {
    if (this.pending) { await this.pending; return this.snapshot(); }
    if (this.state.status !== 'available') throw new Error('请先检查更新');
    return this.run('downloading', () => this.updater.downloadUpdate());
  }
  async install() {
    if (this.state.status !== 'downloaded') throw new Error('请先下载更新');
    if (this.installing) throw new Error('正在准备安装');
    this.installing = true;
    try {
      await this.prepareInstall();
      this.updater.quitAndInstall(true, true);
    } finally { this.installing = false; }
  }
}

module.exports = { UpdateService };
