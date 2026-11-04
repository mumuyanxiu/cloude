'use strict';

// Real Electron renderer/preload/IPC and Windows encrypted credentials. The SSH
// boundary is replaced before the first window loads: no real device is used.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const temporaryRoot = require('node:fs').mkdtempSync(path.join(os.tmpdir(), 'workspace-autoconnect-flow-'));
const dataDirectory = path.join(temporaryRoot, 'state');
const browserDirectory = path.join(dataDirectory, 'browser-cache');
require('node:fs').mkdirSync(browserDirectory, { recursive: true });
process.env.CLOUDE_TEST = '1';
process.env.CLOUDE_DATA = dataDirectory;
const { app, dialog, shell } = require('electron');
if (!app) throw new Error('Run using Electron after npm run build.');
app.setPath('userData', dataDirectory);
app.setPath('sessionData', browserDirectory);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const checks = [];
async function until(check, label, timeout = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeout) { if (await check()) return; await pause(30); }
  throw new Error(`Timed out: ${label}`);
}

async function run() {
  const outputDirectory = path.resolve(__dirname, '..', 'output');
  const workspace = '/home/fixture/claude-workspace';
  const project = `${workspace}/remembered-project`;
  const configuration = { host: 'fixture-autoconnect', port: 22, username: 'fixture', authType: 'key', privateKeyPath: 'C:/fixture/key', workspace, claudePath: 'claude', autoConnect: true };
  const fixture = config => ({
    connection: config,
    projects: [{ id: 'remembered-project', name: 'remembered-project', path: project, connectionKey: `${config.username}@${config.host}:${config.port}:${config.workspace}` }],
    conversations: [{ id: 'remembered-conversation', projectId: 'remembered-project', sessionId: 'remembered-session', title: '上次的对话', updatedAt: 1, messages: [{ id: 'remembered-message', role: 'assistant', content: '这段历史应在自动连接后保留。' }] }],
    settings: { activeProjectId: 'remembered-project', activeConversationId: 'remembered-conversation', panelWidth: 420 },
  });
  await fs.mkdir(dataDirectory, { recursive: true });
  await fs.writeFile(path.join(dataDirectory, 'workspace.json'), JSON.stringify(fixture(configuration)));
  const unexpected = () => { throw new Error('Unexpected native UI in autoconnect fixture test'); };
  dialog.showOpenDialog = unexpected; dialog.showSaveDialog = unexpected;
  dialog.showMessageBox = unexpected; dialog.showMessageBoxSync = unexpected;
  shell.openExternal = unexpected; shell.showItemInFolder = unexpected;
  const main = require('../electron/main.cjs');
  const calls = { connect: [], disconnect: 0, listFiles: [] };
  let failuresRemaining = 0;
  main.remote.clientFactory = () => { throw new Error('Real SSH forbidden in autoconnect-flow test'); };
  main.remote.connect = async config => {
    calls.connect.push({ ...config });
    if (failuresRemaining > 0) { failuresRemaining--; throw new Error('模拟 远程设备 暂时离线'); }
    return { home: '/home/fixture', workspace, hostname: 'fixture-workspace', claudeAvailable: true, claudeVersion: 'fixture-only' };
  };
  main.remote.disconnect = async () => { calls.disconnect++; };
  main.remote.getUsage = async () => ({ available: false, limits: [], fetchedAt: Date.now(), message: '模拟设备未提供额度数据' });
  main.remote.listFiles = async remotePath => { calls.listFiles.push(remotePath); return []; };
  const window = await main.ready;
  window.webContents.setBackgroundThrottling(false);
  const evaluate = async code => {
    try { return await window.webContents.executeJavaScript(code); }
    catch (error) { throw new Error(`Renderer evaluation failed: ${code}\n${error.message}`); }
  };
  const invoke = (name, value) => evaluate(`window.workspace[${JSON.stringify(name)}](${value === undefined ? '' : JSON.stringify(value)})`);
  const click = selector => evaluate(`(() => { const e=document.querySelector(${JSON.stringify(selector)}); if(!e) throw new Error('Missing target '+${JSON.stringify(selector)}); e.click(); })()`);
  const clickText = text => evaluate(`(() => { const e=[...document.querySelectorAll('.modal button')].find(e=>e.textContent.trim()===${JSON.stringify(text)}); if(!e) throw new Error('Missing button '+${JSON.stringify(text)}); if(e.disabled) throw new Error('Disabled button '+${JSON.stringify(text)}); e.click(); })()`);
  const fillPassword = async value => {
    await evaluate(`(() => { const e=document.querySelector('input[autocomplete="current-password"]'); if(!e) throw new Error('Missing password field'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)}); e.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    await pause(40);
  };
  const connected = () => evaluate('document.querySelector(".connection-button")?.textContent === "已连接"');
  const waitFormError = text => until(() => evaluate(`document.querySelector('.form-error')?.textContent.includes(${JSON.stringify(text)})`), `connection error: ${text}`);
  const check = async (name, action) => { await action(); checks.push(name); console.log(`PASS ${name}`); };
  const reloadWith = async state => {
    // Await the current renderer's effects before swapping its persisted state.
    await pause(100); await main.store.queue;
    await main.store.save(state);
    await window.loadFile(path.resolve(__dirname, '..', 'dist', 'index.html'));
    await until(() => evaluate('!!document.querySelector("textarea")'), 'reloaded renderer');
    await pause(100);
  };

  try {
    await check('startup connects exactly once and preserves selected project and conversation', async () => {
      await until(connected, 'automatic startup connection');
      await pause(600);
      assert.equal(calls.connect.length, 1);
      assert.equal(await evaluate('document.querySelector(".breadcrumb-project")?.textContent'), 'remembered-project');
      assert.ok(await evaluate('document.querySelector(".assistant-message")?.textContent.includes("这段历史应在自动连接后保留。")'));
      assert.equal((await invoke('loadState')).conversations[0].sessionId, 'remembered-session');
    });

    await check('manual disconnect stays disconnected without startup retry', async () => {
      await click('.connection-button'); await clickText('断开连接');
      await until(async () => !(await connected()), 'manual disconnect');
      await pause(650);
      assert.equal(calls.connect.length, 1);
      assert.equal(calls.disconnect, 1);
    });

    await check('disabled automatic connection makes no SSH attempt', async () => {
      const before = calls.connect.length;
      await reloadWith(fixture({ ...configuration, autoConnect: false }));
      await pause(600);
      assert.equal(calls.connect.length, before);
      assert.equal(await connected(), false);
      await click('.connection-button');
      assert.equal(await evaluate('[...document.querySelectorAll(".modal label")].find(e=>e.textContent.includes("启动时自动连接"))?.querySelector("input")?.checked'), false);
    });

    await check('unconfigured empty key path does not initiate connection', async () => {
      const before = calls.connect.length;
      await reloadWith(fixture({ ...configuration, privateKeyPath: '' }));
      await pause(600);
      assert.equal(calls.connect.length, before);
      assert.equal(await connected(), false);
    });

    const passwordConfiguration = { ...configuration, authType: 'password', privateKeyPath: '' };
    const fixturePassword = 'fixture-password-only-DO-NOT-USE-67231';
    await check('missing password opens repair form; one input saves encrypted credentials', async () => {
      const before = calls.connect.length;
      await reloadWith(fixture(passwordConfiguration));
      await waitFormError('密码');
      assert.equal(calls.connect.length, before, 'missing credentials must fail before SSH');
      await fillPassword(fixturePassword); await clickText('连接设备');
      await until(connected, 'password form connects');
      await until(async () => (await invoke('loadState')).connection.credentialSaved === true, 'encrypted credential saved');
      assert.equal(calls.connect.at(-1).password, fixturePassword);
      const rendererState = await invoke('loadState');
      assert.equal(rendererState.connection.password, undefined);
      assert.equal(rendererState.connection.passphrase, undefined);
      await main.store.queue;
      for (const name of (await fs.readdir(dataDirectory)).filter(name => name.endsWith('.json'))) {
        assert.ok(!(await fs.readFile(path.join(dataDirectory, name), 'utf8')).includes(fixturePassword), `plaintext leaked into ${name}`);
      }
    });

    await check('subsequent startup decrypts saved password only in main and connects once', async () => {
      const before = calls.connect.length;
      await reloadWith(fixture(passwordConfiguration));
      await until(connected, 'automatic password connection');
      await pause(600);
      assert.equal(calls.connect.length, before + 1);
      assert.equal(calls.connect.at(-1).password, fixturePassword);
      assert.ok(!(await evaluate('document.body.innerText')).includes(fixturePassword));
    });

    await check('offline startup shows recoverable error and manual retry reuses credential', async () => {
      const before = calls.connect.length;
      failuresRemaining = 1;
      await reloadWith(fixture(passwordConfiguration));
      await waitFormError('模拟 远程设备 暂时离线');
      await pause(650);
      assert.equal(calls.connect.length, before + 1, 'offline startup must not repeatedly retry');
      assert.equal(await evaluate(`document.querySelector('input[autocomplete="current-password"]').value`), '');
      await clickText('连接设备');
      await until(connected, 'manual retry');
      assert.equal(calls.connect.length, before + 2);
      assert.equal(calls.connect.at(-1).password, fixturePassword);
    });

    await check('disabling startup connection clears remembered credential and persists across reload', async () => {
      await click('.connection-button');
      await evaluate('(() => { const input=[...document.querySelectorAll(".modal label")].find(e=>e.textContent.includes("启动时自动连接"))?.querySelector("input"); if(!input?.checked) throw new Error("Auto-connect checkbox not enabled"); input.click(); })()');
      await pause(40); await clickText('仅保存配置');
      await until(async () => { const state = await invoke('loadState'); return state.connection.autoConnect === false && state.connection.credentialSaved !== true; }, 'disable saved and credential cleared');
      const before = calls.connect.length;
      await reloadWith(await invoke('loadState'));
      await pause(600);
      assert.equal(calls.connect.length, before);
      assert.equal(await connected(), false);
    });

    await fs.mkdir(outputDirectory, { recursive: true });
    const report = { passed: checks.length, checks, realSSH: false, actualElectronIPC: true, actualWindowsEncryption: process.platform === 'win32', testDataDirectory: temporaryRoot };
    await fs.writeFile(path.join(outputDirectory, 'autoconnect-flow.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } finally {
    await main.store.queue;
    console.log(`TEST_DATA_DIRECTORY ${temporaryRoot}`);
  }
}

run().then(() => app.exit(0), error => { console.error(error.stack || error); app.exit(1); });
