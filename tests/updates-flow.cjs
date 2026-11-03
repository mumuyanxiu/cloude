const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { app, dialog, shell } = require('electron');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
  for (let attempt = 0; attempt < 250; attempt++) { if (await check()) return; await pause(40); }
  throw new Error(`Timed out: ${label}`);
}
async function run() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-updates-flow-'));
  process.env.CLOUD_CLAUDE_TEST = '1'; process.env.CLOUD_CLAUDE_DATA = directory;
  const main = require('../electron/main.cjs');
  const config = { host: 'fixture', port: 22, username: 'fixture', authType: 'agent', workspace: '/home/fixture/workspace', claudePath: 'claude', autoConnect: true };
  const projectPath = `${config.workspace}/sample`;
  await main.store.save({ connection: config, projects: [{ id: 'project', name: 'sample', path: projectPath, connectionKey: `fixture@fixture:22:${config.workspace}` }], conversations: [] });
  main.remote.clientFactory = () => { throw new Error('Real SSH forbidden'); };
  main.remote.connect = async () => ({ home: '/home/fixture', workspace: config.workspace, hostname: 'fixture', claudeAvailable: true });
  main.remote.disconnect = async () => {};
  main.remote.openProject = async value => ({ path: value, name: 'sample' });
  main.remote.listFiles = async () => [{ name: 'main.py', path: `${projectPath}/main.py`, type: 'file', mtime: 1, size: 10 }];
  main.remote.readFile = async () => ({ content: 'print(1)\n', mtime: 1, size: 9 });
  main.remote.saveFile = async () => ({ mtime: 2, size: 20 });
  main.remote.runCommand = async options => ({ jobId: options.jobId });
  main.remote.getUsage = async () => ({ available: false, limits: [], fetchedAt: Date.now() });
  const unexpected = () => { throw new Error('Unexpected native UI'); };
  dialog.showOpenDialog = unexpected; dialog.showSaveDialog = unexpected;
  dialog.showMessageBox = unexpected; dialog.showMessageBoxSync = unexpected;
  const external = []; shell.openExternal = async url => { external.push(url); };
  shell.showItemInFolder = unexpected;
  const installs = [];
  let offline = true;
  main.updates.updater = {
    async checkForUpdates() {
      if (offline) throw new Error('fixture offline');
      main.updates.set({ status: 'available', version: '99.0.0' });
    },
    async downloadUpdate() {
      main.updates.set({ status: 'downloading', percent: 45 }); await pause(100);
      main.updates.set({ status: 'downloaded', percent: 100 });
    },
    quitAndInstall(...args) { installs.push(args); },
  };
  const window = await main.ready;
  window.webContents.setBackgroundThrottling(false);
  const evaluate = async code => {
    try { return await window.webContents.executeJavaScript(code); }
    catch (error) { throw new Error(`Renderer failed: ${code}\n${error.message}`); }
  };
  const clickText = text => evaluate(`(() => { const button=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)}); if(!button || button.disabled) throw new Error('Button unavailable: '+${JSON.stringify(text)}); button.click(); })()`);
  const invoke = (name, value) => evaluate(`window.workspace[${JSON.stringify(name)}](${value === undefined ? '' : JSON.stringify(value)})`);
  const checks = [];
  const check = async (name, callback) => { await callback(); checks.push(name); console.log(`PASS ${name}`); };
  await until(() => evaluate('document.querySelector(".connection-button")?.textContent === "已连接"'), 'fixture connection');
  await check('development UI opens only configured release page', async () => {
    await evaluate('[...document.querySelectorAll(".sidebar-settings")].find(b=>b.textContent.startsWith("应用更新")).click()');
    await until(() => evaluate('document.querySelector(".modal")?.textContent.includes("开发模式")'), 'development update UI');
    await clickText('下载页面');
    assert.match(external[0], /^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/latest$/);
  });
  await check('real preload and renderer show an update failure and allow retry', async () => {
    main.updates.set({ status: 'idle' });
    await until(() => evaluate('[...document.querySelectorAll(".modal button")].some(b=>b.textContent === "检查更新")'), 'check button');
    await clickText('检查更新');
    await until(() => evaluate('document.querySelector(".modal [role=alert]")?.textContent.includes("fixture offline")'), 'offline error');
    offline = false; await clickText('检查更新');
    await until(() => evaluate('document.querySelector(".modal")?.textContent.includes("发现新版本 99.0.0")'), 'update available');
    await clickText('下载更新');
    await until(() => evaluate('!!document.querySelector("progress")'), 'download progress');
    await until(() => evaluate('document.querySelector(".modal")?.textContent.includes("版本 99.0.0 已就绪")'), 'download ready');
  });
  await check('main process refuses installation while a remote task is active', async () => {
    await invoke('runCommand', { jobId: 'fixture-job', projectPath, command: 'fixture' });
    await assert.rejects(invoke('installUpdate'), /完成正在运行的任务/);
    assert.equal(installs.length, 0);
    main.remote._emit({ kind: 'terminal', type: 'exit', jobId: 'fixture-job', code: 0 });
  });
  await check('unsaved editor disables restart until saved, then install drains persistence', async () => {
    await evaluate('document.querySelector(".modal [aria-label=关闭窗口]").click()');
    await evaluate('document.querySelector(".file-open").click()');
    await until(() => evaluate('!!document.querySelector(".cm-content")'), 'editor');
    await evaluate('document.querySelector(".cm-content").focus()');
    await window.webContents.insertText('# fixture edit\n');
    await until(() => evaluate('!!document.querySelector(".dirty-dot")'), 'dirty buffer');
    await evaluate('[...document.querySelectorAll(".sidebar-settings")].find(b=>b.textContent.startsWith("应用更新")).click()');
    assert.equal(await evaluate('[...document.querySelectorAll(".modal button")].find(b=>b.textContent === "重启并安装").disabled'), true);
    await evaluate('document.querySelector(".modal [aria-label=关闭窗口]").click()');
    await evaluate(`document.querySelector('[aria-label="保存文件 · Ctrl+S"]').click()`);
    await until(() => evaluate('!document.querySelector(".dirty-dot")'), 'saved buffer');
    await evaluate('[...document.querySelectorAll(".sidebar-settings")].find(b=>b.textContent.startsWith("应用更新")).click()');
    await clickText('重启并安装');
    await until(() => installs.length === 1, 'installer');
    assert.deepEqual(installs, [[true, true]]);
  });
  const output = path.resolve(__dirname, '..', 'output'); await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, 'updates-flow.json'), JSON.stringify({ passed: checks.length, checks, realUpdateServer: false }, null, 2));
  window.destroy(); await main.credentials.queue; await main.store.queue; app.quit();
}
run().catch(error => { console.error(error.stack || error); app.exit(1); });
