'use strict';

// Run with: node_modules/.bin/electron tests/electron-smoke.cjs
// Loads the real packaged renderer, preload, and main-process IPC. No SSH
// connection or native picker is opened; the device boundary is replaced below.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, dialog, shell } = require('electron');

if (!app) throw new Error('Run this script with Electron, after npm run build.');

const projectRoot = path.resolve(__dirname, '..');
const outputDirectory = path.join(projectRoot, 'output');
const checks = [];
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function until(check, label, timeout = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await check()) return;
    await pause(40);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function run() {
  await fs.access(path.join(projectRoot, 'dist', 'index.html'));
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-electron-smoke-'));
  process.env.CLOUD_CLAUDE_TEST = '1';
  process.env.CLOUD_CLAUDE_DATA = path.join(temporaryRoot, 'state');

  // Any unexpected dialog or browser/explorer launch fails this test instead
  // of prompting the user. Individual checks replace only the dialog needed.
  const unexpected = () => { throw new Error('Unexpected native UI in smoke test'); };
  dialog.showOpenDialog = unexpected;
  dialog.showSaveDialog = unexpected;
  dialog.showMessageBox = unexpected;
  dialog.showMessageBoxSync = unexpected;
  shell.openExternal = unexpected;
  shell.showItemInFolder = unexpected;

  let secondaryWindow;
  const main = require('../electron/main.cjs');
  const calls = { connect: 0, listFiles: 0, download: 0, upload: 0 };
  main.remote.clientFactory = () => { throw new Error('Real SSH is forbidden in this smoke test'); };
  main.remote.connect = async config => {
    calls.connect++;
    return { home: '/home/test', workspace: '/home/test/workspace', hostname: config.host, claudeVersion: 'smoke-fixture', claudeAvailable: true };
  };
  main.remote.disconnect = async () => {};
  main.remote.getUsage = async () => ({ available: false, limits: [], fetchedAt: Date.now(), message: '模拟设备未提供额度数据' });
  main.remote.listFiles = async () => { calls.listFiles++; return []; };
  main.remote.download = async () => { calls.download++; throw new Error('Unexpected remote download'); };
  main.remote.upload = async () => { calls.upload++; throw new Error('Unexpected remote upload'); };

  const check = async (name, callback) => {
    await callback();
    checks.push(name);
    console.log(`PASS ${name}`);
  };

  try {
    const window = await main.ready;
    const evaluate = code => window.webContents.executeJavaScript(code);
    const invoke = (name, value) => evaluate(`window.workspace[${JSON.stringify(name)}](${JSON.stringify(value) ?? ''})`);
    await until(() => evaluate("!!document.querySelector('#root')?.children.length && document.body.innerText.length > 40"), 'renderer content');
    await until(() => evaluate("!!document.querySelector('textarea')"), 'chat composer');
    // Let the renderer's initial debounced persistence finish before IPC state
    // fixtures are written, otherwise that independent save can race the check.
    await pause(550);
    await main.store.queue;

    let layout;
    await check('real renderer renders without horizontal overflow', async () => {
      layout = await evaluate(`(() => {
        const bounds = element => {
          if (!element) return null;
          const rect = element.getBoundingClientRect();
          return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, bottom: rect.bottom, right: rect.right };
        };
        return {
          viewport: { width: innerWidth, height: innerHeight },
          scrollWidth: document.documentElement.scrollWidth,
          bodyText: document.body.innerText,
          root: bounds(document.getElementById('root')),
          composer: bounds(document.querySelector('textarea')),
          buttons: document.querySelectorAll('button').length,
          fatalError: !!document.querySelector('.fatal'),
        };
      })()`);
      assert.equal(layout.fatalError, false);
      assert.ok(layout.root.width > 900 && layout.root.height > 500, 'root fills a desktop workspace');
      assert.ok(layout.buttons >= 5, 'workspace controls rendered');
      assert.ok(layout.scrollWidth <= layout.viewport.width + 1, 'no horizontal document overflow');
      assert.ok(layout.composer.width > 250 && layout.composer.height > 20, 'composer is visible');
      assert.ok(layout.composer.bottom <= layout.viewport.height + 1, 'composer remains inside viewport');
      assert.match(layout.bodyText, /未连接|连接设备|连接设备/);
    });

    await fs.mkdir(outputDirectory, { recursive: true });
    const screenshot = await window.webContents.capturePage();
    assert.ok(!screenshot.isEmpty(), 'desktop screenshot is nonempty');
    await fs.writeFile(path.join(outputDirectory, 'app-desktop.png'), screenshot.toPNG());

    await check('renderer has isolated preload API without Node access', async () => {
      const actual = await evaluate(`({ requireType: typeof require, processType: typeof process, keys: Object.keys(window.workspace), invokeType: typeof window.workspace.invoke, frozen: Object.isFrozen(window.workspace) })`);
      assert.equal(actual.requireType, 'undefined');
      assert.equal(actual.processType, 'undefined');
      assert.equal(actual.invokeType, 'undefined');
      assert.ok(actual.keys.includes('download') && actual.keys.includes('onEvent'));
      assert.equal(actual.frozen, true);
      const preferences = window.webContents.getLastWebPreferences();
      assert.equal(preferences.nodeIntegration, false);
      assert.equal(preferences.contextIsolation, true);
      assert.equal(preferences.sandbox, true);
    });

    await check('preload events expose only payload and unsubscribe correctly', async () => {
      await evaluate(`window.__smokeEvents = []; window.__smokeUnsubscribe = window.workspace.onEvent((...args) => window.__smokeEvents.push(args)); void 0;`);
      const event = { kind: 'smoke-test', value: 'payload-only' };
      window.webContents.send('workspace:event', event);
      await until(() => evaluate('window.__smokeEvents.length === 1'), 'preload event');
      assert.deepEqual(await evaluate('window.__smokeEvents'), [[event]]);
      assert.equal(await evaluate('typeof window.__smokeUnsubscribe()'), 'undefined', 'unsubscribe must not return an Electron object');
      window.webContents.send('workspace:event', { kind: 'smoke-test', value: 'ignored' });
      await pause(100);
      assert.equal(await evaluate('window.__smokeEvents.length'), 1);
    });

    await check('IPC rejects a second native window before touching the remote', async () => {
      secondaryWindow = new BrowserWindow({ show: false, webPreferences: { preload: path.join(projectRoot, 'electron', 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true } });
      await secondaryWindow.loadURL('about:blank');
      const before = calls.listFiles;
      await assert.rejects(secondaryWindow.webContents.executeJavaScript("window.workspace.listFiles({path:'/home/test/workspace'})"), /非工作台页面/);
      assert.equal(calls.listFiles, before);
      secondaryWindow.destroy();
      secondaryWindow = undefined;
    });

    await check('IPC rejects malformed file requests and unsafe external URLs', async () => {
      const before = calls.listFiles;
      await assert.rejects(invoke('listFiles', null), /无效请求/);
      assert.equal(calls.listFiles, before);
      await assert.rejects(invoke('openExternal', { url: 'file:///C:/Windows/notepad.exe' }), /http\(s\)/);
      await assert.rejects(invoke('showInFolder', { path: path.join(temporaryRoot, 'not-downloaded.txt') }), /本次下载/);
    });

    await check('real IPC persistence excludes connection secrets', async () => {
      await invoke('saveState', { connection: { host: 'smoke-only', port: 22, username: 'test', authType: 'password', password: 'do-not-save-password', passphrase: 'do-not-save-passphrase', privateKey: 'do-not-save-key-data', workspace: '~/workspace', claudePath: 'claude' }, projects: [], conversations: [] });
      const saved = await fs.readFile(path.join(temporaryRoot, 'state', 'workspace.json'), 'utf8');
      for (const secret of ['do-not-save-password', 'do-not-save-passphrase', 'do-not-save-key-data']) assert.ok(!saved.includes(secret));
      assert.equal((await invoke('loadState')).connection.host, 'smoke-only');
    });

    const config = { host: 'smoke-only', port: 22, username: 'test', authType: 'agent', workspace: '~/workspace', claudePath: 'claude' };
    await invoke('connect', config);

    await check('cancelled native pickers do not start transfers', async () => {
      dialog.showSaveDialog = async () => ({ canceled: true });
      dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
      assert.deepEqual(await invoke('download', { path: '/home/test/workspace/report.txt' }), { canceled: true });
      assert.deepEqual(await invoke('upload', { directory: '/home/test/workspace' }), { canceled: true });
      assert.equal(await invoke('pickPrivateKey'), null);
      assert.equal(calls.download, 0);
      assert.equal(calls.upload, 0);
    });

    await check('native Save As IPC saves exact bytes and grants only that reveal path', async () => {
      const destination = path.join(temporaryRoot, 'download-result.bin');
      const bytes = Buffer.from([0, 255, 13, 10, 128, 42]);
      await fs.writeFile(destination, 'old contents');
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: destination });
      main.remote.download = async (_remotePath, localPath) => {
        calls.download++;
        await fs.writeFile(localPath, bytes);
        return { bytes: bytes.length };
      };
      const result = await invoke('download', { path: '/home/test/workspace/report.bin' });
      assert.deepEqual(result, { canceled: false, localPath: destination, bytes: bytes.length });
      assert.deepEqual(await fs.readFile(destination), bytes);
      let revealed;
      shell.showItemInFolder = target => { revealed = target; };
      await invoke('showInFolder', { path: result.localPath });
      assert.equal(revealed, destination);
      await assert.rejects(invoke('showInFolder', { path: path.join(temporaryRoot, 'other.bin') }), /本次下载/);
      assert.equal(revealed, destination);
      main.remote.download = async () => { calls.download++; throw new Error('Unexpected remote download'); };
    });

    await check('pending native picker blocks device switching without starting a transfer', async () => {
      let choose;
      dialog.showSaveDialog = () => new Promise(resolve => { choose = resolve; });
      const downloadsBefore = calls.download;
      const pending = invoke('download', { path: '/home/test/workspace/report.txt' });
      await until(() => !!choose, 'native picker fixture');
      const connectionsBefore = calls.connect;
      await assert.rejects(invoke('connect', { ...config, host: 'another-smoke-host' }), /文件操作正在进行/);
      assert.equal(calls.connect, connectionsBefore);
      choose({ canceled: true });
      assert.deepEqual(await pending, { canceled: true });
      assert.equal(calls.download, downloadsBefore);
    });

    await check('connection loss invalidates a pending native Save As selection', async () => {
      let choose;
      dialog.showSaveDialog = () => new Promise(resolve => { choose = resolve; });
      const downloadsBefore = calls.download;
      const pending = invoke('download', { path: '/home/test/workspace/report.txt' });
      // Observe the expected rejection before completing the pending picker.
      const rejected = assert.rejects(pending, /连接已变化/);
      await until(() => !!choose, 'native picker fixture');
      main.remote._emit({ kind: 'connection', status: 'disconnected', message: 'Smoke test injected connection loss' });
      choose({ canceled: false, filePath: path.join(temporaryRoot, 'should-not-exist.txt') });
      await rejected;
      assert.equal(calls.download, downloadsBefore);
      await assert.rejects(fs.access(path.join(temporaryRoot, 'should-not-exist.txt')), { code: 'ENOENT' });
    });

    await main.store.queue;
    const report = { passed: checks.length, checks, realSSH: false, testDataDirectory: temporaryRoot, screenshot: path.join(outputDirectory, 'app-desktop.png'), layout };
    await fs.writeFile(path.join(outputDirectory, 'electron-smoke.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ passed: checks.length, screenshot: report.screenshot, realSSH: false }));
  } finally {
    if (secondaryWindow && !secondaryWindow.isDestroyed()) secondaryWindow.destroy();
    await main.store.queue;
    // Chromium still owns files in userData until the Electron process exits.
    // Leave this isolated mkdtemp directory for post-exit cleanup. In-process
    // removal can fail with EBUSY and must never hide the original test error.
    console.log(`TEST_DATA_DIRECTORY ${temporaryRoot}`);
  }
}

run().then(() => app.exit(0), error => { console.error(error.stack || error); app.exit(1); });
