const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { UpdateService } = require('../electron/updates.cjs');
function fixture(prepareInstall) {
  const updater = new EventEmitter();
  updater.checkForUpdates = async () => updater.emit('update-available', { version: '1.1.0' });
  updater.downloadUpdate = async () => {
    updater.emit('download-progress', { percent: 40 });
    updater.emit('update-downloaded', { version: '1.1.0' });
  };
  updater.installs = [];
  updater.quitAndInstall = (...args) => updater.installs.push(args);
  return { updater, service: new UpdateService({ updater, version: '1.0.0', supported: true, prepareInstall }) };
}
test('installed update checks, reports progress, and installs only after preparation', async () => {
  let prepared = false;
  const { service, updater } = fixture(async () => { prepared = true; });
  const states = [];
  service.on('change', state => states.push(state));
  assert.equal(updater.autoDownload, false);
  assert.equal(updater.autoInstallOnAppQuit, false);
  assert.equal((await service.check()).status, 'available');
  assert.equal((await service.download()).status, 'downloaded');
  assert.ok(states.some(state => state.status === 'downloading' && state.percent === 40));
  await service.install();
  assert.equal(prepared, true);
  assert.deepEqual(updater.installs, [[true, true]]);
  // Rechecking must retain an already verified download.
  assert.equal((await service.check()).status, 'downloaded');
});
test('network and checksum failures remain retryable and never install', async () => {
  const { service, updater } = fixture();
  updater.checkForUpdates = async () => { throw new Error('offline'); };
  assert.equal((await service.check()).status, 'error');
  updater.checkForUpdates = async () => updater.emit('update-available', { version: '1.1.0' });
  await service.check();
  updater.downloadUpdate = async () => { const error = new Error('sha512 checksum mismatch'); updater.emit('error', error); throw error; };
  assert.equal((await service.download()).status, 'error');
  await assert.rejects(service.install(), /下载更新/);
  assert.equal(updater.installs.length, 0);
  updater.checkForUpdates = async () => updater.emit('update-not-available');
  assert.equal((await service.check()).status, 'latest');
});
test('concurrent checks share one request and return state snapshots', async () => {
  const { service, updater } = fixture();
  let finish, calls = 0;
  updater.checkForUpdates = () => { calls++; return new Promise(resolve => { finish = resolve; }); };
  const first = service.check(), second = service.check();
  await Promise.resolve();
  updater.emit('update-not-available'); finish();
  const results = await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.ok(results.every(state => state?.status === 'latest'));
});
test('active tasks can block install without losing the downloaded update', async () => {
  let busy = true;
  const { service, updater } = fixture(async () => { if (busy) throw new Error('task running'); });
  await service.check(); await service.download();
  await assert.rejects(service.install(), /task running/);
  assert.equal(service.snapshot().status, 'downloaded');
  assert.equal(updater.installs.length, 0);
  busy = false; await service.install();
  assert.equal(updater.installs.length, 1);
});
test('development builds do not contact the update provider', async () => {
  const service = new UpdateService({ updater: null, version: '1.0.0', supported: false });
  assert.equal((await service.check()).status, 'unsupported');
  await assert.rejects(service.download(), /检查更新/);
  await assert.rejects(service.install(), /下载更新/);
});
