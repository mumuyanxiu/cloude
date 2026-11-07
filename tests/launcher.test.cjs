'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createWorkspaceRestarter } = require('../electron/workspace-restart.cjs');
const {
  configureProfile, configurePaseoEnvironment, loadDefaultMode, resolveMode,
  relaunchArgs, saveDefaultMode,
} = require('../electron/workspace-startup.cjs');

test('new profiles use Paseo and explicit flags override the persisted preference', () => {
  assert.equal(resolveMode(['Cloude.exe'], 'paseo'), 'paseo');
  assert.equal(resolveMode(['Cloude.exe', '--legacy'], 'paseo'), 'legacy');
  assert.equal(resolveMode(['Cloude.exe', '--legacy', '--paseo'], 'legacy'), 'paseo');
  assert.deepEqual(relaunchArgs(['electron.exe', '.', '--legacy', '--disable-gpu'], 'paseo'), ['.', '--disable-gpu', '--paseo']);
});

test('profile bootstrap preserves Cloude identity and isolates Paseo agent state', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cloude-bootstrap-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const paths = { appData: directory };
  const app = { isPackaged: true, setName(name) { this.name = name; }, setAppUserModelId(id) { this.appId = id; }, getPath(name) { return paths[name]; }, setPath(name, value) { paths[name] = value; } };
  const profile = configureProfile(app, {});
  assert.equal(profile, path.join(directory, 'Cloud Claude'));
  assert.equal(app.name, 'Cloude');
  assert.equal(paths.userData, profile);
  assert.equal(paths.sessionData, path.join(profile, 'browser-cache'));
  const env = { PASEO_HOME: 'unrelated-paseo-profile' };
  configurePaseoEnvironment(profile, env);
  assert.equal(env.PASEO_HOME, path.join(profile, 'paseo'));
  assert.equal(env.PASEO_ELECTRON_USER_DATA_DIR, profile);
  assert.equal(env.PASEO_TEST_APP_NAME, 'Cloude');
  assert.equal(configureProfile(app, { CLOUDE_DATA: path.join(directory, 'isolated') }), path.join(directory, 'isolated'));
});

test('startup preference writes preserve existing workspace and encrypted credentials', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cloude-startup-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, 'workspace.json'), 'legacy workspace bytes');
  await fs.writeFile(path.join(directory, 'credentials.json'), 'encrypted credential bytes');
  assert.equal(loadDefaultMode(directory), 'paseo');
  await saveDefaultMode(directory, 'legacy');
  assert.equal(loadDefaultMode(directory), 'legacy');
  assert.equal(await fs.readFile(path.join(directory, 'workspace.json'), 'utf8'), 'legacy workspace bytes');
  assert.equal(await fs.readFile(path.join(directory, 'credentials.json'), 'utf8'), 'encrypted credential bytes');
  await fs.writeFile(path.join(directory, 'startup.json'), '{broken');
  assert.throws(() => loadDefaultMode(directory), /原文件已保留/);
  assert.equal(await fs.readFile(path.join(directory, 'startup.json'), 'utf8'), '{broken');
});

function restartFixture() {
  const app = new EventEmitter();
  const restarts = [];
  app.relaunch = value => restarts.push(value);
  app.quit = () => {};
  const window = new EventEmitter();
  window.webContents = new EventEmitter();
  window.isDestroyed = () => false;
  window.close = () => {};
  return { app, window, restarts };
}

test('a canceled window close leaves no relaunch pending for a later ordinary quit', async () => {
  const { app, window, restarts } = restartFixture();
  window.close = () => window.emit('close', { defaultPrevented: true });
  const restart = createWorkspaceRestarter({ app, getWindows: () => [window] });
  assert.equal(await restart(['--legacy']), false);
  app.emit('quit');
  assert.deepEqual(restarts, []);
  assert.equal(window.listenerCount('closed'), 0);
});

test('canceling beforeunload also clears the request and permits a fresh restart', async () => {
  const { app, window, restarts } = restartFixture();
  window.close = () => window.webContents.emit('will-prevent-unload', { defaultPrevented: false });
  const restart = createWorkspaceRestarter({ app, getWindows: () => [window] });
  assert.equal(await restart(['--legacy']), false);
  app.emit('quit');
  assert.deepEqual(restarts, []);
  window.close = () => window.emit('closed');
  const accepted = restart(['--paseo']);
  assert.deepEqual(restarts, []);
  app.emit('quit');
  assert.equal(await accepted, true);
  assert.deepEqual(restarts, [{ args: ['--paseo'] }]);
});

test('relaunch waits for all windows and actual exit, including an app.exit quit', async () => {
  const { app, window: first, restarts } = restartFixture();
  const { window: second } = restartFixture();
  const restart = createWorkspaceRestarter({ app, getWindows: () => [first, second] });
  const accepted = restart(['--legacy']);
  first.emit('closed');
  assert.deepEqual(restarts, []);
  second.emit('closed');
  assert.deepEqual(restarts, []);
  app.emit('quit');
  assert.equal(await accepted, true);
  assert.deepEqual(restarts, [{ args: ['--legacy'] }]);
});

test('a vetoed will-quit or a replacement window cancels a completed close request', async () => {
  for (const event of ['will-quit', 'browser-window-created']) {
    const { app, window, restarts } = restartFixture();
    window.close = () => window.emit('closed');
    const restart = createWorkspaceRestarter({ app, getWindows: () => [window] });
    const accepted = restart(['--legacy']);
    app.emit(event, { defaultPrevented: true });
    assert.equal(await accepted, false);
    app.emit('quit');
    assert.deepEqual(restarts, []);
  }
});
