'use strict';

// Full renderer workflows through real preload + main IPC, with the remote
// boundary replaced by fixtures. This NEVER connects to a real remote device.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { app, dialog, shell } = require('electron');
if (!app) throw new Error('Run using Electron after npm run build.');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const checks = [];
async function until(check, label, timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await check()) return; await pause(30); }
  throw new Error(`Timed out: ${label}`);
}

async function run() {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-renderer-flow-'));
  process.env.CLOUDE_TEST = '1';
  process.env.CLOUDE_DATA = path.join(temporaryRoot, 'state');
  const outputDirectory = path.resolve(__dirname, '..', 'output');
  const main = require('../electron/main.cjs');
  const loadLegacyState = main.store.load.bind(main.store);
  main.store.load = async () => { const state = await loadLegacyState(); return { ...state, settings: { ...state.settings, durableTasks: false } }; };
  const calls = { connect: [], mkdir: [], read: [], save: [], chat: [], commands: [], download: [] };
  const root = '/home/fixture/claude-workspace';
  const project = `${root}/sample-project`;
  const initial = 'def main():\n    print("远程设备 fixture")\n\nmain()\n';
  const remoteFiles = new Map([[`${project}/main.py`, initial], [`${project}/report.txt`, '模拟设备测试报告\nFixture only.\n']]);
  main.remote.clientFactory = () => { throw new Error('Real SSH forbidden in renderer-flow test'); };
  main.remote.connect = async config => { calls.connect.push(config); return { home: '/home/fixture', workspace: root, hostname: 'fixture-workspace', claudeAvailable: true, claudeVersion: 'fixture-only' }; };
  main.remote.disconnect = async () => {};
  main.remote.getUsage = async () => ({ available: false, limits: [], fetchedAt: Date.now(), message: '模拟设备未提供额度数据' });
  main.remote.mkdir = async remotePath => { calls.mkdir.push(remotePath); return { path: remotePath }; };
  main.remote.listFiles = async remotePath => [...remoteFiles].filter(([file]) => path.posix.dirname(file) === remotePath).map(([file, content]) => ({ name: path.posix.basename(file), path: file, type: 'file', size: Buffer.byteLength(content), mtime: 1234 }));
  main.remote.readFile = async remotePath => { calls.read.push(remotePath); if (!remoteFiles.has(remotePath)) throw new Error('Fixture file missing'); const content = remoteFiles.get(remotePath); return { content, mtime: 1234, size: Buffer.byteLength(content) }; };
  main.remote.saveFile = async (remotePath, content, expectedMtime) => { calls.save.push({ remotePath, content, expectedMtime }); remoteFiles.set(remotePath, content); return { mtime: 1235, size: Buffer.byteLength(content) }; };
  main.remote.startChat = async options => { calls.chat.push(options); return { jobId: options.jobId }; };
  main.remote.runCommand = async options => { calls.commands.push(options); return { jobId: options.jobId }; };
  main.remote.download = async (remotePath, destination) => { calls.download.push(remotePath); const bytes = Buffer.from(remoteFiles.get(remotePath)); await fs.writeFile(destination, bytes); return { bytes: bytes.length }; };
  main.remote.getDiff = async () => ({ isGit: true, diff: 'diff --git a/main.py b/main.py\n--- a/main.py\n+++ b/main.py\n@@ -1 +1 @@\n-print("old")\n+print("远程设备 fixture")' });
  const destination = path.join(temporaryRoot, 'report.txt');
  const unexpected = () => { throw new Error('Unexpected native dialog in fixture test'); };
  dialog.showOpenDialog = unexpected;
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: destination });
  dialog.showMessageBox = unexpected;
  dialog.showMessageBoxSync = unexpected;
  shell.openExternal = unexpected;
  shell.showItemInFolder = unexpected;

  const window = await main.ready;
  window.webContents.setBackgroundThrottling(false);
  window.webContents.on('console-message', event => { if (event.level === 'warning' || event.level === 'error') console.log('RENDERER', event.message); });
  const evaluate = async code => { try { return await window.webContents.executeJavaScript(code); } catch (error) { throw new Error(`Renderer evaluation failed: ${code}\n${error.message}`); } };
  const click = selector => evaluate(`(() => { const element=document.querySelector(${JSON.stringify(selector)}); if(!element) throw new Error('Missing click target: '+${JSON.stringify(selector)}); element.click(); })()`);
  const clickText = (text, scope = 'button') => evaluate(`(() => { const element=[...document.querySelectorAll(${JSON.stringify(scope)})].find(e=>e.textContent.trim()===${JSON.stringify(text)}); if(!element) throw new Error('Missing button: '+${JSON.stringify(text)}); element.click(); })()`);
  const fill = async (selector, value) => {
    await evaluate(`(() => { const element=document.querySelector(${JSON.stringify(selector)}); if(!element) throw new Error('Missing input'); element.focus(); const prototype=element.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype,'value').set.call(element,${JSON.stringify(value)}); element.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    await pause(30);
  };
  const field = async (label, value) => {
    const selector = await evaluate(`(() => { const label=[...document.querySelectorAll('.modal label')].find(e=>e.textContent.trim().startsWith(${JSON.stringify(label)})); if(!label) throw new Error('Missing label'); const input=label.querySelector('input'); input.setAttribute('data-test-field',${JSON.stringify(label)}); return '[data-test-field="'+${JSON.stringify(label)}+'"]'; })()`);
    await fill(selector, value);
  };
  const check = async (name, callback) => { await callback(); checks.push(name); console.log(`PASS ${name}`); };
  const send = payload => main.remote._emit(payload);

  try {
    await until(() => evaluate('!!document.querySelector("textarea")'), 'initial renderer');
    await check('connection modal keeps text input focus across React updates', async () => {
      await click('.connection-button');
      await field('主机名或 IP 地址', 'fixture-n');
      await field('主机名或 IP 地址', 'fixture-workspace');
      assert.equal(await evaluate('document.activeElement.value'), 'fixture-workspace');
      await pause(100);
      assert.equal(await evaluate('document.activeElement.getAttribute("data-test-field")'), '主机名或 IP 地址');
      await field('登录用户', 'fixture');
      await field('私钥文件', '/fixture/key');
      await field('工作目录', root);
      await clickText('连接设备', '.modal button');
      await until(() => calls.connect.length === 1, 'remote connect');
      await until(() => evaluate('document.querySelector(".modal h2")?.textContent === "打开一个项目"'), 'project modal');
      assert.equal(calls.connect[0].host, 'fixture-workspace');
    });

    await check('create project via actual form and list fixture files', async () => {
      await field('项目名称', 'sample-project');
      await clickText('创建并打开', '.modal button');
      await until(() => calls.mkdir.length === 1, 'remote directory creation');
      await until(() => evaluate('[...document.querySelectorAll(".file-open")].some(e=>e.textContent.includes("main.py"))'), 'remote files list');
      assert.equal(calls.mkdir[0], project);
      assert.equal(await evaluate('document.querySelector(".breadcrumb-project").textContent'), 'sample-project');
    });

    await check('CodeMirror reads, edits, and saves real IPC content', async () => {
      await evaluate('[...document.querySelectorAll(".file-open")].find(e=>e.textContent.includes("main.py")).click()');
      await until(() => evaluate('!!document.querySelector(".cm-content")'), 'code editor');
      assert.equal(calls.read[0], `${project}/main.py`);
      await evaluate('document.querySelector(".cm-content").focus()');
      await window.webContents.insertText('# edited through actual editor\n');
      await until(() => evaluate(`!document.querySelector('[aria-label="保存文件 · Ctrl+S"]').disabled`), 'dirty editor');
      await click('[aria-label="保存文件 · Ctrl+S"]');
      await until(() => calls.save.length === 1, 'save IPC');
      assert.ok(calls.save[0].content.includes('# edited through actual editor'));
      assert.equal(calls.save[0].expectedMtime, 1234);
      assert.equal(calls.save[0].remotePath, `${project}/main.py`);
      await until(() => evaluate('document.querySelector(".editor-footer").textContent.includes("已同步")'), 'saved state');
    });

    await check('streaming Claude response deduplicates final text and persists session ID', async () => {
      await fill('textarea[aria-label="发送给 Claude 的消息"]', '检查项目并生成报告。');
      await click('[aria-label="发送消息"]');
      await until(() => calls.chat.length === 1, 'Claude job creation');
      const job = calls.chat[0];
      assert.equal(job.projectPath, project);
      assert.equal(job.mode, 'edit');
      assert.equal(job.allowCommands, true);
      const emit = event => send({ kind: 'chat', jobId: job.jobId, conversationId: job.conversationId, type: 'event', event });
      emit({ type: 'system', subtype: 'init', session_id: 'fixture-session-123' });
      emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '模拟报告已' } } });
      emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '生成。' } } });
      emit({ type: 'assistant', uuid: 'fixture-assistant-1', message: { id: 'fixture-message-1', content: [{ type: 'text', text: '模拟报告已生成。' }, { type: 'tool_use', id: 'fixture-write-1', name: 'Write', input: { file_path: `${project}/report.txt`, content: remoteFiles.get(`${project}/report.txt`) } }] } });
      emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'fixture-write-1', content: 'Fixture write complete' }] } });
      emit({ type: 'result', session_id: 'fixture-session-123', result: '模拟报告已生成。', is_error: false });
      send({ kind: 'chat', jobId: job.jobId, conversationId: job.conversationId, type: 'exit', code: 0 });
      await until(() => evaluate('document.querySelector(".assistant-message .markdown")?.textContent.includes("模拟报告已生成。")'), 'assistant response');
      assert.equal(await evaluate('document.querySelector(".assistant-message .markdown").textContent'), '模拟报告已生成。');
      await until(async () => { const data = await main.store.load(); return data.conversations.some(c => c.sessionId === 'fixture-session-123'); }, 'persisted session ID');
      await main.store.queue;
      const saved = await main.store.load();
      const conversation = saved.conversations.find(c => c.sessionId === 'fixture-session-123');
      assert.equal(conversation.messages[1].content, '模拟报告已生成。');
      assert.deepEqual(conversation.messages[1].files, [`${project}/report.txt`]);
      assert.equal(conversation.messages[1].tools[0].result, 'Fixture write complete');
    });

    await check('chat file card downloads through native Save As IPC', async () => {
      await click('.message-files [aria-label="下载 report.txt 到 Windows"]');
      await until(() => calls.download.length === 1, 'file card download');
      await until(async () => { try { return (await fs.readFile(destination, 'utf8')) === remoteFiles.get(`${project}/report.txt`); } catch { return false; } }, 'downloaded bytes');
      assert.equal(calls.download[0], `${project}/report.txt`);
      assert.equal(await fs.readFile(destination, 'utf8'), remoteFiles.get(`${project}/report.txt`));
    });

    await check('terminal form invokes command and displays actual emitted output', async () => {
      await click('.terminal-heading > button');
      await fill('.terminal-input input', 'python3 main.py');
      await click('[aria-label="运行命令"]');
      await until(() => calls.commands.length === 1, 'terminal job');
      const job = calls.commands[0];
      assert.equal(job.command, 'python3 main.py');
      send({ kind: 'terminal', jobId: job.jobId, type: 'data', data: '\u001b[' });
      send({ kind: 'terminal', jobId: job.jobId, type: 'data', data: '32m远程设备 fixture\u001b[0m\r\n' });
      send({ kind: 'terminal', jobId: job.jobId, type: 'exit', code: 0 });
      await until(() => evaluate('document.querySelector(".terminal-output").textContent.includes("进程退出 · 0")'), 'terminal completion');
      assert.ok(!(await evaluate('document.querySelector(".terminal-output").textContent')).includes('\u001b'));
    });

    await fs.mkdir(outputDirectory, { recursive: true });
    await evaluate(`(() => { const note=document.createElement('div'); note.textContent='模拟设备测试 · 未连接真实 远程设备'; note.style.cssText='position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:9999;background:#fff2dc;border:1px solid #bc9a62;color:#815d2b;padding:5px 12px;border-radius:5px;font:11px sans-serif;'; note.id='fixture-banner'; document.body.append(note); })()`);
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    await pause(150);
    await fs.writeFile(path.join(outputDirectory, 'app-connected-fixture.png'), (await window.webContents.capturePage()).toPNG());
    await evaluate('document.getElementById("fixture-banner").remove()');

    await check('connection error preserves running handles; disconnect preserves dirty editor buffer', async () => {
      await fill('.terminal-input input', 'long-running-fixture');
      await click('[aria-label="运行命令"]');
      await until(() => calls.commands.length === 2, 'second terminal job');
      await evaluate('document.querySelector(".cm-content").focus()');
      await window.webContents.insertText('# unsaved before connection loss\n');
      await until(() => evaluate('document.querySelector(".editor-footer").textContent.includes("未保存")'), 'dirty buffer before disconnect');
      send({ kind: 'connection', status: 'error', message: 'Fixture recoverable channel error' });
      await pause(60);
      assert.equal(await evaluate('document.querySelector(".connection-button").textContent'), '已连接');
      assert.ok(await evaluate(`!!document.querySelector('[aria-label="停止终端程序"]')`));
      send({ kind: 'connection', status: 'disconnected', message: 'Fixture network disconnect' });
      await until(() => evaluate('document.querySelector(".connection-button").textContent === "连接设备"'), 'disconnected state');
      assert.ok(await evaluate('document.querySelector(".cm-content").textContent.includes("# unsaved before connection loss")'));
      assert.ok(await evaluate('document.querySelector(".editor-footer").textContent.includes("未保存")'));
      assert.equal(await evaluate(`document.querySelector('[aria-label="保存文件 · Ctrl+S"]').disabled`), true);
    });

    await main.store.queue;
    const report = { passed: checks.length, checks, realSSH: false, screenshotIsFixture: true, testDataDirectory: temporaryRoot, screenshot: path.join(outputDirectory, 'app-connected-fixture.png') };
    await fs.writeFile(path.join(outputDirectory, 'renderer-flow.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } finally {
    await main.store.queue;
    console.log(`TEST_DATA_DIRECTORY ${temporaryRoot}`);
  }
}
run().then(() => app.exit(0), error => { console.error(error.stack || error); app.exit(1); });
