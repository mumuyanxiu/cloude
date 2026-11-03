'use strict';

// Run with Node. Starts three independent, sequential Electron processes with
// fixture-only SSH. Unlike a renderer reload, the main process and encryption
// provider are discarded between enrollment and automatic restoration.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const fixturePassword = 'cross-process-fixture-only-58692';
const workspace = '/home/fixture/claude-workspace';
const configuration = { host: 'fixture-crossprocess', port: 22, username: 'fixture', authType: 'password', privateKeyPath: '', workspace, claudePath: 'claude', autoConnect: true };

async function until(check, label, timeout = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeout) { if (await check()) return; await pause(60); }
  throw new Error(`Timed out: ${label}`);
}

async function worker(stage, directory) {
  if (!path.isAbsolute(directory) || !path.basename(path.dirname(directory)).startsWith('workspace-credentials-process-')) throw new Error('Only the isolated fixture data directory is allowed');
  process.env.CLOUD_CLAUDE_TEST = '1'; process.env.CLOUD_CLAUDE_DATA = directory;
  const browserDirectory = path.join(directory, 'browser-cache');
  require('node:fs').mkdirSync(browserDirectory, { recursive: true });
  const { app, dialog, shell } = require('electron');
  app.setPath('userData', directory); app.setPath('sessionData', browserDirectory);
  const unexpected = () => { throw new Error('Unexpected native dialog or external launch in cross-process test'); };
  dialog.showOpenDialog = unexpected; dialog.showSaveDialog = unexpected;
  dialog.showMessageBox = unexpected; dialog.showMessageBoxSync = unexpected;
  shell.openExternal = unexpected; shell.showItemInFolder = unexpected;
  const calls = [];
  const main = require('../electron/main.cjs');
  main.remote.clientFactory = () => { throw new Error('Real SSH is forbidden in cross-process test'); };
  main.remote.connect = async config => {
    assert.ok(config.password === fixturePassword, 'restored credential must exactly match the synthetic fixture');
    calls.push({ host: config.host, credentialMatched: true });
    return { home: '/home/fixture', workspace, hostname: config.host, claudeVersion: 'fixture-only', claudeAvailable: true };
  };
  main.remote.disconnect = async () => {};
  main.remote.listFiles = async () => [];
  main.remote.getUsage = async () => ({ available: false, limits: [], fetchedAt: Date.now(), message: '跨进程模拟测试，无真实账户查询' });
  try {
    const window = await main.ready;
    window.webContents.setBackgroundThrottling(false);
    const evaluate = code => window.webContents.executeJavaScript(code);
    if (stage === 'enroll') {
      await until(() => evaluate('document.querySelector(".form-error")?.textContent.includes("密码")'), 'initial password form');
      assert.equal(calls.length, 0, 'no password must fail before SSH');
      await evaluate(`(() => { const e=document.querySelector('input[autocomplete="current-password"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(fixturePassword)}); e.dispatchEvent(new Event('input',{bubbles:true})); })()`);
      await pause(50);
      await evaluate(`Array.from(document.querySelectorAll('.modal button')).find(e=>e.textContent.trim()==='连接设备').click()`);
    }
    await until(() => evaluate('document.querySelector(".connection-button")?.textContent === "已连接"'), `${stage} connection`);
    await main.credentials.queue; await main.store.queue;
    await pause(150);
    assert.equal(calls.length, 1, 'exactly one connection per process');
    const rendererState = await evaluate('window.workspace.loadState()');
    assert.equal(rendererState.connection.credentialSaved, true);
    assert.equal(rendererState.connection.password, undefined);
    assert.equal(rendererState.connection.passphrase, undefined);
    assert.equal(await evaluate('!!document.querySelector(".form-error")'), false);
    const record = await main.store.read('credentials.json', null);
    assert.ok(Object.values(record.entries).some(entry => entry.scheme === 'windows-dpapi-current-user-v1'));
    for (const name of (await fs.readdir(directory)).filter(name => name.endsWith('.json'))) {
      assert.ok(!(await fs.readFile(path.join(directory, name), 'utf8')).includes(fixturePassword), `plaintext fixture leaked into ${name}`);
    }
    await main.credentials.queue; await main.store.queue;
    console.log(`CROSSPROCESS_RESULT ${JSON.stringify({ stage, pid: process.pid, connects: calls.length, credentialMatched: true, rendererContainsSecret: false, scheme: 'windows-dpapi-current-user-v1' })}`);
    app.exit(0);
  } catch (error) {
    console.error(error.stack || error);
    app.exit(1);
  }
}

async function run() {
  if (process.platform !== 'win32') throw new Error('This integration check requires Windows DPAPI');
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-credentials-process-'));
  const directory = path.join(temporaryRoot, 'original');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'workspace.json'), JSON.stringify({
    connection: configuration,
    projects: [{ id: 'fixture-project', name: 'cross-process-fixture', path: `${workspace}/fixture`, connectionKey: `fixture@fixture-crossprocess:22:${workspace}` }],
    conversations: [], settings: { activeProjectId: 'fixture-project' },
  }));
  const executable = require('electron');
  async function launch(stage, dataDirectory) {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const result = await new Promise((resolve, reject) => {
      const child = spawn(executable, ['--disable-gpu', __filename, '--worker', stage, dataDirectory], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      const timer = setTimeout(() => { child.kill(); reject(new Error(`${stage} process timed out`)); }, 45000);
      child.stdout.on('data', bytes => { stdout += bytes.toString(); });
      child.stderr.on('data', bytes => { stderr += bytes.toString(); });
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('close', code => {
        clearTimeout(timer);
        if (code !== 0) { reject(new Error(`${stage} exited ${code}\n${stdout}\n${stderr}`)); return; }
        const line = stdout.split(/\r?\n/).find(value => value.startsWith('CROSSPROCESS_RESULT '));
        if (!line) { reject(new Error(`${stage} did not produce an assertion result\n${stdout}\n${stderr}`)); return; }
        resolve(JSON.parse(line.slice('CROSSPROCESS_RESULT '.length)));
      });
    });
    console.log(`PASS ${stage}: independent Electron process ${result.pid}`);
    return result;
  }
  const results = [];
  results.push(await launch('enroll', directory));
  results.push(await launch('restore', directory));
  // DPAPI credentials must survive a fresh Chromium cache. Copy only the
  // fixture state and DPAPI ciphertext.
  const relocated = path.join(temporaryRoot, 'fresh-profile');
  await fs.mkdir(relocated);
  for (const name of ['workspace.json', 'credentials.json']) await fs.copyFile(path.join(directory, name), path.join(relocated, name));
  results.push(await launch('fresh-profile-restore', relocated));
  assert.equal(new Set(results.map(result => result.pid)).size, 3);
  const report = { passed: 3, checks: ['first process enrolls using Windows DPAPI without plaintext persistence', 'second independent process automatically restores and connects without entering password', 'third process restores ciphertext with a fresh Chromium profile'], actualIndependentElectronProcesses: true, actualWindowsDPAPI: true, realSSH: false, testDataDirectory: temporaryRoot, results };
  const outputDirectory = path.resolve(__dirname, '..', 'output');
  await fs.mkdir(outputDirectory, { recursive: true });
  await fs.writeFile(path.join(outputDirectory, 'credentials-crossprocess.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}

const workerIndex = process.argv.indexOf('--worker');
if (workerIndex >= 0) {
  void worker(process.argv[workerIndex + 1], process.argv[workerIndex + 2]);
} else {
  run().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
}
