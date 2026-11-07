'use strict';

// Node orchestrates the real default Electron entry over loopback CDP. The test
// uses an isolated profile. A model request runs only when the optional
// CLOUDE_TEST_REAL_CODEX flag is explicitly enabled.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const packagedExecutable = process.env.CLOUDE_TEST_EXECUTABLE;
const electron = packagedExecutable || require('electron');
const packageInfo = require('../package.json');
const engineLock = require('../paseo-lock.json');
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function until(check, label, timeout = 60000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const result = await check();
    if (result) return result;
    await pause(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function connectPage(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const response = JSON.parse(event.data);
    const request = pending.get(response.id);
    if (!request) return;
    pending.delete(response.id);
    clearTimeout(request.timer);
    if (response.error) request.reject(new Error(response.error.message));
    else request.resolve(response.result);
  });
  socket.addEventListener('close', () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error('Desktop page closed'));
    }
    pending.clear();
  });
  function command(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, 30000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evaluate(expression) {
    const response = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    return response.result.value;
  }
  return { command, evaluate, close: () => socket.close() };
}

async function launch(dataDirectory, daemonPort) {
  const port = await freePort();
  const env = { ...process.env, CLOUDE_DATA: dataDirectory, PASEO_LISTEN: `127.0.0.1:${daemonPort}` };
  delete env.ELECTRON_RUN_AS_NODE;
  const args = [`--remote-debugging-port=${port}`];
  if (!packagedExecutable) args.unshift('.');
  const child = spawn(electron, args, {
    cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let spawnError;
  child.on('error', error => { spawnError = error; });
  const capture = chunk => { output = (output + chunk.toString()).slice(-16000); };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  try {
    const target = await until(async () => {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null) throw new Error(`Desktop exited before startup (${child.exitCode})\n${output}`);
      try {
        const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json());
        return targets.find(candidate => candidate.type === 'page' && candidate.url.startsWith('paseo://app'));
      } catch { return null; }
    }, 'default Paseo desktop page');
    const page = await connectPage(target.webSocketDebuggerUrl);
    await until(() => page.evaluate('!!window.paseoDesktop && (document.body?.innerText.trim().length || 0) > 30'), 'rendered desktop UI');
    return { child, page, exited, output: () => output };
  } catch (error) {
    child.kill();
    throw new Error(`${error.message}\n${output}`);
  }
}

async function closeDesktop(desktop) {
  await desktop.page.evaluate('window.paseoDesktop.window.getCurrentWindow().close()').catch(error => {
    if (!/closed|WebSocket/i.test(error.message)) throw error;
  });
  await until(() => desktop.child.exitCode !== null || desktop.child.signalCode !== null, 'desktop close', 30000);
  const result = await desktop.exited;
  assert.equal(result.code, 0, desktop.output());
  desktop.page.close();
}

async function connectRuntime(status) {
  const runtime = packagedExecutable
    ? path.join(path.dirname(packagedExecutable), 'resources', 'paseo')
    : path.join(root, 'runtime', 'paseo');
  const resolveRuntime = name => pathToFileURL(require.resolve(name, { paths: [runtime] })).href;
  const { createPaseoApi } = await import(resolveRuntime('@getpaseo/client'));
  const { createHostClient } = await import(resolveRuntime('@getpaseo/client/node'));
  const transport = createHostClient(status.listen, {
    clientId: 'cloude-release-smoke',
    clientType: 'cli',
    connectTimeoutMs: 15000,
    reconnect: { enabled: false },
    localCredential: async () => (await fs.readFile(path.join(status.home, 'local-credential'), 'utf8')).trim(),
  });
  const api = createPaseoApi(transport);
  await transport.connect();
  return { api, transport };
}

async function verifyTerminal(status, temporaryRoot) {
  const { api, transport } = await connectRuntime(status);
  let terminal;
  try {
    const project = path.join(temporaryRoot, 'terminal-project');
    await fs.mkdir(project);
    const workspace = await api.workspaces.open(project);
    terminal = await workspace.terminals.create({
      name: 'Release smoke',
      command: process.platform === 'win32' ? (process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe') : '/bin/sh',
      args: process.platform === 'win32' ? ['/d', '/q'] : [],
    });
    terminal.write('echo CLOUDE_2_PTY_READY>pty-result.txt\r');
    await until(async () => {
      try { return (await fs.readFile(path.join(project, 'pty-result.txt'), 'utf8')).trim() === 'CLOUDE_2_PTY_READY'; }
      catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    }, 'command executed through the native PTY', 30000);
    assert.equal(path.resolve(terminal.current().cwd), project);
    await terminal.kill();
    assert.equal(terminal.current(), null);
    assert.equal((await workspace.terminals.list()).entries.length, 0);
    terminal = null;
    await workspace.archive();
  } finally {
    if (terminal) await terminal.kill().catch(() => {});
    await api.dispose();
    await transport.close();
  }
}

async function verifyCodex(status, temporaryRoot) {
  const { api, transport } = await connectRuntime(status);
  let agent;
  let unsubscribe;
  try {
    const project = path.join(temporaryRoot, 'model-project');
    await fs.mkdir(project);
    const snapshot = await api.providers.waitForReady({ cwd: project, timeoutMs: 60000 });
    const codex = snapshot.entries.find(entry => entry.provider === 'codex' && entry.status === 'ready');
    const model = codex?.models?.find(candidate => candidate.isDefault) || codex?.models?.[0];
    assert.ok(model, 'The authenticated Codex CLI must advertise a model');
    agent = await api.agents.create({
      cwd: project,
      title: 'Cloude release model smoke',
      config: {
        provider: `codex/${model.id}`,
        options: { sandbox_mode: 'read-only', approval_policy: 'never', web_search: 'disabled' },
      },
      prompt: 'Reply with exactly OK. Do not call tools or access files.',
    });
    let timelineUpdates = 0;
    unsubscribe = agent.timeline.subscribe(update => {
      if (update.event.type === 'timeline') timelineUpdates++;
    });
    const result = await agent.waitForFinish(120000);
    assert.equal(result.status, 'idle', 'The real model turn must complete');
    assert.equal(result.lastMessage.trim(), 'OK');
    const report = { passed: 1, provider: 'codex', model: model.id, actualModelRequest: true, completed: true, response: result.lastMessage.trim(), timelineUpdates };
    await fs.mkdir(path.join(root, 'output'), { recursive: true });
    await fs.writeFile(path.join(root, 'output', 'paseo-real-model.json'), JSON.stringify(report, null, 2));
    await agent.archive();
    agent = null;
  } finally {
    if (unsubscribe) unsubscribe();
    if (agent) await agent.archive().catch(() => {});
    await api.dispose();
    await transport.close();
  }
}

async function run() {
  await fs.access(path.join(root, 'runtime', 'paseo', 'desktop-dist', 'main.js'));
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cloude-paseo-flow-'));
  const dataDirectory = path.join(temporaryRoot, 'profile');
  await fs.mkdir(dataDirectory);
  const previousState = JSON.stringify({ connection: { host: 'fixture-only', autoConnect: false }, projects: [], conversations: [] });
  const previousCredentials = JSON.stringify({ version: 1, entries: {} });
  await fs.writeFile(path.join(dataDirectory, 'workspace.json'), previousState);
  await fs.writeFile(path.join(dataDirectory, 'credentials.json'), previousCredentials);
  const daemonPort = await freePort();
  await fs.mkdir(path.join(dataDirectory, 'paseo'));
  await fs.writeFile(path.join(dataDirectory, 'paseo', 'config.json'), JSON.stringify({
    version: 1,
    daemon: { listen: `127.0.0.1:${daemonPort}`, relay: { enabled: false } },
    features: { dictation: { enabled: false }, voiceMode: { enabled: false } },
  }));
  const checks = [];
  let desktop;
  const check = async (name, callback) => {
    await callback();
    checks.push(name);
    console.log(`PASS ${name}`);
  };
  try {
    desktop = await launch(dataDirectory, daemonPort);
    await check('default entry renders the Paseo desktop with an isolated native bridge', async () => {
      const environment = await desktop.page.evaluate('({ title: document.title, url: location.href, requireType: typeof require, nodeVersion: globalThis.process?.versions?.node, processBinding: typeof globalThis.process?.binding, legacyApi: typeof window.workspace, desktopBridge: typeof window.paseoDesktop.invoke, body: document.body.innerText })');
      assert.match(environment.title, /Cloude/i);
      assert.match(environment.url, /^paseo:\/\/app/);
      assert.equal(environment.requireType, 'undefined');
      // Expo installs a browser process.env shim. Node's versions and binding
      // APIs must remain absent from the renderer's main world.
      assert.equal(environment.nodeVersion, undefined);
      assert.equal(environment.processBinding, 'undefined');
      assert.equal(environment.legacyApi, 'undefined');
      assert.equal(environment.desktopBridge, 'function');
      assert.ok(environment.body.trim().length > 30);
      const runtimeInfo = await desktop.page.evaluate("window.paseoDesktop.invoke('desktop_get_runtime_info')");
      assert.equal(runtimeInfo.appVersion, packageInfo.version);
    });
    let firstStatus;
    await check('bundled daemon starts in the Cloude profile and publishes a live process', async () => {
      firstStatus = await until(async () => {
        const status = await desktop.page.evaluate("window.paseoDesktop.invoke('desktop_daemon_status')");
        if (status.status === 'errored') throw new Error(status.error);
        return status.status === 'running' ? status : null;
      }, 'managed daemon');
      assert.equal(path.resolve(firstStatus.home), path.join(dataDirectory, 'paseo'));
      assert.ok(Number.isInteger(firstStatus.pid) && firstStatus.pid > 0);
      process.kill(firstStatus.pid, 0);
      assert.equal(firstStatus.version, engineLock.version);
    });
    await check('legacy workspace and encrypted credential records keep their original bytes', async () => {
      assert.equal(await fs.readFile(path.join(dataDirectory, 'workspace.json'), 'utf8'), previousState);
      assert.equal(await fs.readFile(path.join(dataDirectory, 'credentials.json'), 'utf8'), previousCredentials);
    });
    await check('bundled native PTY executes a command in its workspace and closes cleanly', () => verifyTerminal(firstStatus, temporaryRoot));
    await check('About settings show Cloude 2.0.0 and the engine without a version mismatch', async () => {
      await desktop.page.evaluate('document.querySelector(\'[data-testid="sidebar-settings"]\').click()');
      await until(() => desktop.page.evaluate('Array.from(document.querySelectorAll(\'[role="button"]\')).some(element => ["关于", "About"].includes(element.innerText.trim()))'), 'About settings button');
      await desktop.page.evaluate('Array.from(document.querySelectorAll(\'[role="button"]\')).find(element => ["关于", "About"].includes(element.innerText.trim())).click()');
      let lastText = '';
      const text = await until(async () => {
        const body = await desktop.page.evaluate('document.body?.innerText || ""').catch(() => '');
        lastText = body;
        return body.includes(`v${packageInfo.version}`) && body.includes(`v${engineLock.version}`) ? body : null;
      }, 'application and connected daemon versions in About settings').catch(error => {
        throw new Error(`${error.message}\n${lastText}`);
      });
      assert.ok(!/Version differs from this device|版本与此设备不同/.test(text), 'Matching engine versions must not show a daemon mismatch');
    });
    if (process.env.CLOUDE_TEST_REAL_CODEX === '1') {
      await check('authenticated Codex completes one real model turn through the bundled daemon', () => verifyCodex(firstStatus, temporaryRoot));
    }
    await closeDesktop(desktop);
    desktop = null;
    checks.push('window close exits the real default desktop cleanly');
    desktop = await launch(dataDirectory, daemonPort);
    await check('restart reconnects the isolated daemon and renders the workspace again', async () => {
      const status = await until(async () => {
        const current = await desktop.page.evaluate("window.paseoDesktop.invoke('desktop_daemon_status')");
        return current.status === 'running' ? current : null;
      }, 'daemon after restart');
      assert.equal(path.resolve(status.home), path.join(dataDirectory, 'paseo'));
      assert.equal(await fs.readFile(path.join(dataDirectory, 'workspace.json'), 'utf8'), previousState);
      assert.equal(await fs.readFile(path.join(dataDirectory, 'credentials.json'), 'utf8'), previousCredentials);
    });
    await fs.mkdir(path.join(root, 'output'), { recursive: true });
    const screenshot = path.join(root, 'output', packagedExecutable ? 'paseo-packaged-desktop.png' : 'paseo-desktop.png');
    const capture = await desktop.page.command('Page.captureScreenshot', { format: 'png' });
    assert.ok(capture.data.length > 1000, 'Desktop screenshot must contain rendered pixels');
    await fs.writeFile(screenshot, Buffer.from(capture.data, 'base64'));
    await closeDesktop(desktop);
    desktop = null;
    const report = { version: packageInfo.version, passed: checks.length, checks, screenshot, testDataDirectory: temporaryRoot, actualDefaultEntry: true, actualBundledDaemon: true, actualNativePty: true, actualSettingsVersions: true, packagedExecutable: packagedExecutable || null, realModelRequest: process.env.CLOUDE_TEST_REAL_CODEX === '1' };
    const reportName = packagedExecutable ? 'paseo-packaged-flow.json' : 'paseo-flow.json';
    await fs.writeFile(path.join(root, 'output', reportName), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } finally {
    if (desktop) {
      await desktop.page.evaluate(`(async () => {
        const status = await window.paseoDesktop.invoke('desktop_daemon_status');
        if (status.home === ${JSON.stringify(path.join(dataDirectory, 'paseo'))} && status.pid) {
          await window.paseoDesktop.invoke('stop_desktop_daemon', { pid: status.pid, startedAt: status.startedAt });
        }
      })()`).catch(() => {});
      await closeDesktop(desktop).catch(() => {
        desktop.page.close();
        desktop.child.kill();
      });
    }
    console.log(`TEST_DATA_DIRECTORY ${temporaryRoot}`);
  }
}

run().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
