'use strict';

// Real Electron UI, preload, main upload planning and RemoteClient operations.
// SFTP is backed by isolated temporary files. No real 远程设备 or Claude is contacted.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { Writable } = require('node:stream');
const { LocalSftp } = require('./helpers/local-sftp.cjs');
const temporaryRoot = require('node:fs').mkdtempSync(path.join(os.tmpdir(), 'workspace-folder-upload-'));
const dataDirectory = path.join(temporaryRoot, 'state');
const browserDirectory = path.join(dataDirectory, 'browser-cache');
require('node:fs').mkdirSync(browserDirectory, { recursive: true });
process.env.CLOUDE_TEST = '1'; process.env.CLOUDE_DATA = dataDirectory;
const { app, dialog, shell } = require('electron');
if (!app) throw new Error('Run using Electron after npm run build.');
app.setPath('userData', dataDirectory); app.setPath('sessionData', browserDirectory);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const checks = [];
async function until(check, label, timeout = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeout) { if (await check()) return; await pause(35); }
  throw new Error(`Timed out: ${label}`);
}

async function run() {
  const workspace = '/home/fixture/claude-workspace';
  const project = `${workspace}/folder-fixture`;
  const remoteRoot = path.join(temporaryRoot, 'sftp');
  const localRoot = path.join(temporaryRoot, 'local');
  const physical = remotePath => path.join(remoteRoot, ...remotePath.split('/').filter(Boolean));
  await fs.mkdir(physical(project), { recursive: true });
  await fs.mkdir(physical('/outside'), { recursive: true });
  await fs.mkdir(localRoot);
  await fs.writeFile(path.join(dataDirectory, 'workspace.json'), JSON.stringify({
    connection: { host: 'fixture-folder-upload', port: 22, username: 'fixture', authType: 'key', privateKeyPath: 'C:/fixture/key', workspace, claudePath: 'claude', autoConnect: true },
    projects: [{ id: 'fixture-project', name: 'folder-fixture', path: project, connectionKey: `fixture@fixture-folder-upload:22:${workspace}` }],
    conversations: [], settings: { activeProjectId: 'fixture-project' },
  }));
  const source = path.join(localRoot, '中文 项目');
  const binary = crypto.randomBytes(87239);
  await fs.mkdir(path.join(source, '模型 数据', '空目录'), { recursive: true });
  await fs.mkdir(path.join(source, '根空目录'));
  await fs.writeFile(path.join(source, '说明 文档.txt'), '保留中文与空格\n');
  await fs.writeFile(path.join(source, '模型 数据', '权重.bin'), binary);
  const calls = { dialogs: [], confirmations: [], mutations: [], chat: [] };
  let selectedPaths = [source];
  let confirmationResponse = 1;
  let pickerImplementation = async () => ({ canceled: false, filePaths: selectedPaths });
  dialog.showOpenDialog = async (_window, options) => { calls.dialogs.push(options); return pickerImplementation(); };
  dialog.showMessageBox = async (_window, options) => { calls.confirmations.push(options); return { response: confirmationResponse }; };
  const unexpected = () => { throw new Error('Unexpected native action in folder fixture test'); };
  dialog.showSaveDialog = unexpected; dialog.showMessageBoxSync = unexpected;
  shell.openExternal = unexpected; shell.showItemInFolder = unexpected;
  const main = require('../electron/main.cjs');
  const loadLegacyState = main.store.load.bind(main.store);
  main.store.load = async () => { const state = await loadLegacyState(); return { ...state, settings: { ...state.settings, durableTasks: false } }; };
  let adapter;
  const connectFixture = () => {
    adapter = new LocalSftp(remoteRoot);
    for (const name of ['mkdir', 'rename', 'ext_openssh_rename', 'unlink', 'createWriteStream']) {
      const original = adapter[name].bind(adapter);
      adapter[name] = (...args) => { calls.mutations.push({ operation: name, path: args[0] }); return original(...args); };
    }
    main.remote.generation++;
    main.remote.client = {}; main.remote.sftp = adapter;
    main.remote.home = '/home/fixture'; main.remote.workspace = workspace; main.remote.workspaceInput = workspace;
  };
  main.remote.clientFactory = () => { throw new Error('Real SSH forbidden in folder-upload-flow'); };
  main.remote.connect = async () => { connectFixture(); return { home: '/home/fixture', workspace, hostname: 'fixture-folder-upload', claudeAvailable: true, claudeVersion: 'fixture-only' }; };
  main.remote.disconnect = async () => { main.remote.generation++; main.remote.client = null; main.remote.sftp = null; };
  main.remote._execCapture = async () => ({ code: 0, stdout: JSON.stringify({ sessions: [] }) });
  main.remote.getUsage = async () => ({ available: false, limits: [], fetchedAt: Date.now(), message: '文件夹上传模拟测试' });
  main.remote.startChat = async options => { calls.chat.push(options); return { jobId: options.jobId }; };
  const window = await main.ready;
  window.webContents.setBackgroundThrottling(false);
  const evaluate = async code => { try { return await window.webContents.executeJavaScript(code); } catch (error) { throw new Error(`Renderer evaluation failed: ${code}\n${error.message}`); } };
  const invoke = value => evaluate(`window.workspace.upload(${JSON.stringify(value)})`);
  const click = selector => evaluate(`(() => { const e=document.querySelector(${JSON.stringify(selector)}); if(!e) throw new Error('Missing target '+${JSON.stringify(selector)}); e.click(); })()`);
  const clickText = text => evaluate(`Array.from(document.querySelectorAll('.modal button')).find(e=>e.textContent.trim()===${JSON.stringify(text)}).click()`);
  const connected = () => evaluate('document.querySelector(".connection-button")?.textContent === "已连接"');
  const exists = async file => { try { await fs.lstat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
  const fileNames = async directory => {
    const result = [];
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) result.push(...(await fileNames(absolute)).map(name => `${entry.name}/${name}`));
      else result.push(entry.name);
    }
    return result.sort();
  };
  const reconnect = async () => {
    await click('.connection-button'); await clickText('连接设备');
    await until(connected, 'fixture reconnection');
  };
  const check = async (name, action) => { await action(); checks.push(name); console.log(`PASS ${name}`); };
  const destination = `${project}/中文 项目`;

  try {
    await until(connected, 'initial fixture connection');
    await check('file-pane folder picker uploads nested Unicode, binary files and empty directories', async () => {
      let finishPicker;
      pickerImplementation = () => new Promise(resolve => { finishPicker = resolve; });
      await click('[aria-label="上传文件夹"]');
      await until(() => !!finishPicker, 'native folder picker');
      assert.deepEqual(calls.dialogs.at(-1).properties, ['openDirectory']);
      assert.equal(await evaluate(`document.querySelector('[aria-label="上传文件夹"]').disabled`), true);
      assert.equal(await evaluate(`document.querySelector('[aria-label="上传文件夹并引用"]').disabled`), true);
      finishPicker({ canceled: false, filePaths: [source] });
      await until(() => evaluate('document.querySelector(".toast")?.textContent.includes("已上传 1 个文件夹")'), 'folder upload complete');
      assert.equal(await fs.readFile(physical(`${destination}/说明 文档.txt`), 'utf8'), '保留中文与空格\n');
      assert.deepEqual(await fs.readFile(physical(`${destination}/模型 数据/权重.bin`)), binary);
      assert.deepEqual(await fs.readdir(physical(`${destination}/模型 数据/空目录`)), []);
      assert.deepEqual(await fs.readdir(physical(`${destination}/根空目录`)), []);
      assert.ok((await fileNames(physical(destination))).every(name => !name.includes('.workspace-upload-')));
      await until(() => evaluate('Array.from(document.querySelectorAll(".file-open")).some(e=>e.textContent.includes("中文 项目"))'), 'refreshed uploaded root directory');
      pickerImplementation = async () => ({ canceled: false, filePaths: selectedPaths });
    });

    await check('chat folder attachment references only the uploaded root and sends that path', async () => {
      const attachment = path.join(localRoot, '聊天 附件');
      await fs.mkdir(attachment); await fs.writeFile(path.join(attachment, 'notes.txt'), 'attachment fixture');
      selectedPaths = [attachment];
      await click('[aria-label="上传文件夹并引用"]');
      await until(() => evaluate('document.querySelector(".references")?.textContent.includes("聊天 附件")'), 'folder root reference');
      assert.equal(await evaluate('document.querySelectorAll(".references > span").length'), 1);
      assert.ok(!(await evaluate('document.querySelector(".references").textContent')).includes('notes.txt'));
      await evaluate(`(() => { const e=document.querySelector('textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'请阅读上传的目录。'); e.dispatchEvent(new Event('input',{bubbles:true})); })()`);
      await pause(40); await click('[aria-label="发送消息"]');
      await until(() => calls.chat.length === 1, 'chat with folder reference');
      assert.ok(calls.chat[0].prompt.includes(`${project}/聊天 附件`));
      assert.ok(!calls.chat[0].prompt.includes(`${project}/聊天 附件/notes.txt`));
      main.remote._emit({ kind: 'chat', type: 'event', jobId: calls.chat[0].jobId, conversationId: calls.chat[0].conversationId, event: { type: 'result', result: '模拟回复已收到上传目录。', session_id: 'fixture-folder-session', is_error: false } });
      main.remote._emit({ kind: 'chat', type: 'exit', jobId: calls.chat[0].jobId, conversationId: calls.chat[0].conversationId, code: 0 });
    });

    await check('large file reports live batch progress, write confirmation and stalled response in the file pane', async () => {
      const large = path.join(localRoot, '大模型_16MB.bin');
      const content = crypto.randomBytes(16 * 1024 * 1024);
      await fs.writeFile(large, content);
      selectedPaths = [large];
      const originalWrite = adapter.createWriteStream.bind(adapter);
      const originalRename = adapter.rename.bind(adapter);
      let finishRename;
      adapter.createWriteStream = (...args) => {
        const destination = originalWrite(...args);
        const slow = new Writable({
          write(chunk, encoding, callback) { destination.write(chunk, encoding, error => setTimeout(() => callback(error), 12)); },
          final(callback) { destination.end(callback); },
          destroy(error, callback) { destination.destroy(); callback(error); },
        });
        destination.on('error', error => slow.destroy(error));
        return slow;
      };
      adapter.rename = (...args) => { finishRename = () => originalRename(...args); };
      await evaluate(`window.__uploadEvents=[]; window.__stopUploadEvents=window.workspace.onEvent(e=>{if(e.type==='upload-progress')window.__uploadEvents.push(e)}); true;`);
      try {
        await click('[aria-label="上传文件"]');
        await until(() => evaluate(`Number(document.querySelector('[aria-label="上传总进度"]')?.getAttribute('aria-valuenow')) > 0`), 'visible byte progress');
        await until(() => evaluate(`document.querySelector('.upload-progress-secondary')?.textContent.includes('/s')`), 'measured upload speed');
        const progress = await evaluate(`({ text:document.querySelector('.upload-progress').textContent, percent:Number(document.querySelector('[aria-label="上传总进度"]').getAttribute('aria-valuenow')) })`);
        assert.ok(progress.percent > 0 && progress.percent < 100);
        assert.match(progress.text, /大模型_16MB.bin/);
        assert.match(progress.text, /16.0 MB/);
        assert.match(progress.text, /文件 0 \/ 1/);
        assert.ok(!(await evaluate('document.body.innerText')).includes('这个文件夹还是空的'));
        await evaluate(`(() => { const n=document.createElement('div');n.id='progress-fixture-banner';n.textContent='大文件上传测试 · 模拟慢速 SFTP，未连接真实 远程设备';n.style.cssText='position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:9999;background:#fff2dc;padding:5px 12px;border:1px solid #bc9a62;font:11px sans-serif';document.body.append(n) })()`);
        await fs.mkdir(path.resolve(__dirname, '..', 'output'), { recursive: true });
        await fs.writeFile(path.resolve(__dirname, '..', 'output', 'upload-progress-fixture.png'), (await window.webContents.capturePage()).toPNG());
        window.setSize(1040, 700); await pause(120);
        const layout = await evaluate(`(() => {const e=document.querySelector('.upload-progress'),r=e.getBoundingClientRect();return {right:r.right,bottom:r.bottom,width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth}})()`);
        assert.ok(layout.right <= layout.width && layout.bottom < layout.height && layout.scrollWidth <= layout.width + 1);
        await fs.writeFile(path.resolve(__dirname, '..', 'output', 'upload-progress-minimum-fixture.png'), (await window.webContents.capturePage()).toPNG());
        await until(() => !!finishRename, 'remote rename awaiting completion');
        await until(() => evaluate(`document.querySelector('.upload-progress-heading')?.textContent.includes('正在确认写入')`), 'write confirmation phase');
        assert.notEqual(await evaluate(`document.querySelector('[aria-label="上传总进度"]').getAttribute('aria-valuenow')`), '100');
        await click('[aria-label="收起工作区"]');
        await until(() => evaluate('!document.querySelector(".upload-progress")'), 'closed progress pane');
        await click('[aria-label="展开工作区"]');
        await until(() => evaluate(`document.querySelector('.upload-progress-secondary')?.textContent.includes('/s')`), 'preserved speed after reopening pane');
        await evaluate('window.__realNow=Date.now; Date.now=()=>window.__realNow()+20000; true;');
        await until(() => evaluate(`document.querySelector('.upload-progress-wait')?.textContent.includes('没有进度更新')`), 'stalled response notice');
        await evaluate('Date.now=window.__realNow; true;');
        finishRename();
        await until(() => evaluate('!document.querySelector(".upload-progress") && document.querySelector(".toast")?.textContent.includes("已上传 1 个文件")'), 'large file confirmed complete');
        assert.deepEqual(await fs.readFile(physical(`${project}/大模型_16MB.bin`)), content);
        const events = await evaluate('window.__uploadEvents');
        for (const phase of ['scanning', 'checking', 'preparing', 'uploading', 'committing', 'verifying', 'complete']) assert.ok(events.some(event => event.phase === phase), `Missing ${phase}`);
        const completed = events.at(-1);
        assert.equal(completed.filesCompleted, 1);
        assert.equal(completed.bytesTransferred, content.length);
        assert.equal(completed.bytesTotal, content.length);
      } finally {
        adapter.createWriteStream = originalWrite; adapter.rename = originalRename;
        await evaluate('window.__stopUploadEvents();if(window.__realNow)Date.now=window.__realNow;document.getElementById("progress-fixture-banner")?.remove()');
        window.setSize(1480, 960);
      }
    });

    await check('default upload selects multiple files and preserves exact bytes', async () => {
      const first = path.join(localRoot, '旧入口.txt'); const second = path.join(localRoot, '旧入口.bin');
      await fs.writeFile(first, '旧文件上传兼容'); await fs.writeFile(second, binary.subarray(0, 513));
      selectedPaths = [first, second];
      const result = await invoke({ directory: project });
      assert.equal(result.canceled, false); assert.equal(result.files.length, 2);
      assert.ok(calls.dialogs.at(-1).properties.includes('openFile'));
      assert.ok(calls.dialogs.at(-1).properties.includes('multiSelections'));
      assert.equal(await fs.readFile(physical(`${project}/旧入口.txt`), 'utf8'), '旧文件上传兼容');
      assert.deepEqual(await fs.readFile(physical(`${project}/旧入口.bin`)), binary.subarray(0, 513));
    });

    await check('cancelled folder overwrite creates no directories or files and preserves originals', async () => {
      await fs.writeFile(path.join(source, '说明 文档.txt'), '明确覆盖后的内容');
      await fs.mkdir(path.join(source, '新目录'));
      await fs.writeFile(path.join(source, '新目录', 'new.txt'), 'new file');
      selectedPaths = [source]; confirmationResponse = 0;
      const before = calls.mutations.length;
      const result = await invoke({ directory: project, kind: 'folder' });
      assert.equal(result.canceled, true); assert.equal(calls.mutations.length, before);
      assert.equal(await fs.readFile(physical(`${destination}/说明 文档.txt`), 'utf8'), '保留中文与空格\n');
      assert.equal(await exists(physical(`${destination}/新目录`)), false);
      assert.ok(calls.confirmations.at(-1).detail.includes('说明 文档.txt'));
    });

    await check('approved folder overwrite replaces confirmed files and merges new children', async () => {
      confirmationResponse = 1;
      const result = await invoke({ directory: project, kind: 'folder' });
      assert.deepEqual(result.folders, [destination]); assert.equal(result.files.length, 3);
      assert.equal(await fs.readFile(physical(`${destination}/说明 文档.txt`), 'utf8'), '明确覆盖后的内容');
      assert.equal(await fs.readFile(physical(`${destination}/新目录/new.txt`), 'utf8'), 'new file');
      assert.deepEqual(await fs.readFile(physical(`${destination}/模型 数据/权重.bin`)), binary);
    });

    await check('local junctions and remote symlink escapes are rejected before any upload mutation', async () => {
      const withJunction = path.join(localRoot, '含本地链接');
      const outsideSource = path.join(localRoot, '链接外部源');
      await fs.mkdir(withJunction); await fs.mkdir(outsideSource);
      await fs.writeFile(path.join(outsideSource, 'private.txt'), 'must not upload');
      await fs.symlink(outsideSource, path.join(withJunction, 'link'), 'junction');
      selectedPaths = [withJunction]; let before = calls.mutations.length;
      await assert.rejects(invoke({ directory: project, kind: 'folder' }), /链接|junction|symbolic/i);
      assert.equal(calls.mutations.length, before);
      assert.equal(await exists(physical(`${project}/含本地链接`)), false);
      const remoteLinked = path.join(localRoot, '含远程链接');
      await fs.mkdir(path.join(remoteLinked, 'child'), { recursive: true });
      await fs.writeFile(path.join(remoteLinked, 'child', 'secret.txt'), 'replacement');
      await fs.mkdir(physical(`${project}/含远程链接`));
      await fs.writeFile(physical('/outside/secret.txt'), 'keep outside');
      adapter.links.set(`${project}/含远程链接/child`, '/outside');
      selectedPaths = [remoteLinked]; before = calls.mutations.length;
      await assert.rejects(invoke({ directory: project, kind: 'folder' }), /链接|工作目录/);
      assert.equal(calls.mutations.length, before);
      assert.equal(await fs.readFile(physical('/outside/secret.txt'), 'utf8'), 'keep outside');
    });

    await check('connection loss while the native picker is open invalidates its selection', async () => {
      let finishPicker;
      pickerImplementation = () => new Promise(resolve => { finishPicker = resolve; });
      const before = calls.mutations.length;
      const pending = invoke({ directory: project, kind: 'folder' });
      const rejected = assert.rejects(pending, /连接已变化|连接.*变化/);
      await until(() => !!finishPicker, 'pending native selection');
      main.remote._emit({ kind: 'connection', status: 'disconnected', message: '模拟连接变化' });
      finishPicker({ canceled: false, filePaths: [source] });
      await rejected; assert.equal(calls.mutations.length, before);
      pickerImplementation = async () => ({ canceled: false, filePaths: selectedPaths });
      await reconnect();
    });

    await check('a mid-file transfer failure removes partial data and retains completed files', async () => {
      const failing = path.join(localRoot, '中途失败');
      await fs.mkdir(failing);
      await fs.writeFile(path.join(failing, 'a.txt'), 'completed file');
      await fs.writeFile(path.join(failing, 'b.bin'), binary);
      await fs.writeFile(path.join(failing, 'c.txt'), 'must not begin');
      selectedPaths = [failing];
      const original = adapter.createWriteStream.bind(adapter); let count = 0;
      adapter.createWriteStream = (remotePath, options) => {
        count++;
        if (count !== 2) return original(remotePath, options);
        return new Writable({ write(chunk, _encoding, callback) {
          fs.writeFile(physical(remotePath), chunk.subarray(0, 7), { flag: 'wx' }).then(() => callback(new Error('模拟传输中断')), callback);
        } });
      };
      await assert.rejects(invoke({ directory: project, kind: 'folder' }), /模拟传输中断/);
      adapter.createWriteStream = original;
      const completed = await fileNames(physical(`${project}/中途失败`));
      assert.deepEqual(completed, ['a.txt']);
      assert.equal(await fs.readFile(physical(`${project}/中途失败/a.txt`), 'utf8'), 'completed file');
      assert.equal(count, 2);
    });

    await check('connection change between files stops the batch while preserving completed uploads', async () => {
      const changing = path.join(localRoot, '连接切换'); await fs.mkdir(changing);
      await fs.writeFile(path.join(changing, 'a.txt'), 'completed before disconnect');
      await fs.writeFile(path.join(changing, 'b.txt'), 'must not upload after disconnect');
      selectedPaths = [changing];
      const original = main.remote.upload.bind(main.remote); let completed = 0;
      main.remote.upload = async (...args) => {
        const result = await original(...args); completed++;
        if (completed === 1) main.remote._emit({ kind: 'connection', status: 'disconnected', message: '模拟文件间断线' });
        return result;
      };
      await assert.rejects(invoke({ directory: project, kind: 'folder' }), /连接.*变化|上传已中断/);
      main.remote.upload = original;
      assert.equal(completed, 1);
      assert.deepEqual(await fileNames(physical(`${project}/连接切换`)), ['a.txt']);
      assert.equal(await fs.readFile(physical(`${project}/连接切换/a.txt`), 'utf8'), 'completed before disconnect');
      await reconnect();
    });

    pickerImplementation = async () => ({ canceled: true, filePaths: [] });
    await click('[aria-label="上传文件夹"]');
    await until(() => evaluate(`!document.querySelector('[aria-label="上传文件夹"]').disabled`), 'fixture screenshot idle state');
    await evaluate(`document.querySelector('[aria-label="关闭提示"]')?.click()`);
    await evaluate(`(() => { const note=document.createElement('div'); note.textContent='文件夹上传测试 · 模拟 SFTP，未连接真实 远程设备'; note.style.cssText='position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:9999;background:#fff2dc;border:1px solid #bc9a62;color:#815d2b;padding:5px 12px;border-radius:5px;font:11px sans-serif;'; document.body.append(note); })()`);
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'); await pause(100);
    const outputDirectory = path.resolve(__dirname, '..', 'output');
    await fs.mkdir(outputDirectory, { recursive: true });
    await fs.writeFile(path.join(outputDirectory, 'folder-upload-fixture.png'), (await window.webContents.capturePage()).toPNG());
    let minimumLayout;
    await check('folder upload controls remain visible and clickable at the minimum window size', async () => {
      window.setSize(1040, 700); await pause(150);
      minimumLayout = await evaluate(`(() => { const labels=['上传文件夹','上传文件夹并引用']; return {width:innerWidth,documentWidth:document.documentElement.scrollWidth,controls:labels.map(label=>{const e=document.querySelector('[aria-label="'+label+'"]');const r=e.getBoundingClientRect();const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {label,left:r.left,right:r.right,top:r.top,bottom:r.bottom,visible:e.contains(hit)}})}; })()`);
      assert.ok(minimumLayout.documentWidth <= minimumLayout.width + 1);
      assert.ok(minimumLayout.controls.every(control => control.visible && control.left >= 0 && control.right <= minimumLayout.width));
      await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      await fs.writeFile(path.join(outputDirectory, 'folder-upload-minimum-fixture.png'), (await window.webContents.capturePage()).toPNG());
    });
    await check('existing external project opens, imports its history once and resumes the original session', async () => {
      const external = '/home/fixture/example-project';
      await fs.mkdir(physical(external), { recursive: true });
      await fs.writeFile(physical(`${external}/original.py`), 'print("existing project")\n');
      const originalCapture = main.remote._execCapture;
      let reads = 0;
      main.remote._execCapture = async command => {
        const session = { sessionId: 'original-session-123', title: '原来的机器人对话', updatedAt: Date.now() };
        if (command.endsWith("'list' ''")) return { code: 0, stdout: JSON.stringify({ sessions: [session] }) };
        assert.ok(command.endsWith("'read' 'original-session-123'")); reads++;
        return { code: 0, stdout: JSON.stringify({ ...session, messages: [
          { id: 'history-user', role: 'user', content: '原来的问题' },
          { id: 'history-assistant', role: 'assistant', content: '原来的回答' },
        ], truncated: false, notice: '模拟历史预览，仅显示文字消息。' }) };
      };
      try {
        await click('[aria-label="读取已有项目"]');
        await until(() => evaluate('!!document.querySelector(".modal form input")'), 'existing project dialog');
        assert.equal(await evaluate('document.querySelectorAll(".modal form input")[0].value'), '');
        assert.equal(await evaluate('document.querySelectorAll(".modal form input")[1].value'), `${workspace}/`);
        await evaluate(`(() => { const e=document.querySelectorAll('.modal form input')[0];Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'example-project');e.dispatchEvent(new Event('input',{bubbles:true})); })()`);
        await evaluate(`(() => { const e=document.querySelectorAll('.modal form input')[1];Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(external)});e.dispatchEvent(new Event('input',{bubbles:true})); })()`);
        await pause(40); await clickText('打开项目');
        await until(() => evaluate('document.querySelector(".conversation-item")?.textContent.includes("原来的机器人对话")'), 'automatic remote session list');
        await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'); await pause(120);
        await fs.writeFile(path.join(outputDirectory, 'existing-sessions-fixture.png'), (await window.webContents.capturePage()).toPNG());
        await click('.conversation-item');
        await until(() => evaluate('document.querySelector(".messages")?.textContent.includes("原来的回答")'), 'imported original messages');
        await until(() => evaluate('document.querySelector(".file-open")?.textContent.includes("original.py")'), 'external project files');
        assert.ok(main.remote.projectRoots.has(external));
        assert.equal(reads, 1);
        await click('[aria-label="刷新历史对话"]');
        await until(() => evaluate('!document.querySelector("[aria-label=刷新历史对话]").disabled'), 'refreshed session list');
        await click('.conversation-item');
        assert.equal(await evaluate('!!document.querySelector(".modal")'), false);
        assert.equal(reads, 1, 'existing local messages are preserved');
        await evaluate(`(() => {const e=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'继续之前的工作');e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
        await pause(40); await click('[aria-label="发送消息"]');
        await until(() => calls.chat.length === 2, 'resume request');
        assert.equal(calls.chat[1].sessionId, 'original-session-123');
        assert.equal(calls.chat[1].projectPath, external);
        main.remote._emit({ kind: 'chat', type: 'event', jobId: calls.chat[1].jobId, conversationId: calls.chat[1].conversationId, event: { type: 'result', result: '模拟继续原有会话', session_id: 'original-session-123' } });
        main.remote._emit({ kind: 'chat', type: 'exit', jobId: calls.chat[1].jobId, conversationId: calls.chat[1].conversationId, code: 0 });
        await pause(600); await main.store.queue;
        main.remote.projectRoots.clear(); main.remote.projectAliases.clear();
        const stored = await main.store.load();
        await evaluate(`window.workspace.connect(${JSON.stringify(stored.connection)})`);
        assert.ok(main.remote.projectRoots.has(external), 'saved external projects are remounted after reconnect');
        await until(() => evaluate('!document.querySelector(".modal") && document.querySelector(".messages")?.textContent.includes("原来的回答")'), 'history view remains open');
        await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'); await pause(120);
        await fs.writeFile(path.join(outputDirectory, 'existing-project-fixture.png'), (await window.webContents.capturePage()).toPNG());
      } finally { main.remote._execCapture = originalCapture; }
    });
    await main.store.queue;
    const report = { passed: checks.length, checks, minimumLayout, actualElectronIPC: true, actualUploadPlanner: true, actualRemoteClient: true, realSSH: false, sftpBoundary: 'LocalSftp fixture', testDataDirectory: temporaryRoot };
    await fs.writeFile(path.join(outputDirectory, 'folder-upload-flow.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } finally { await main.store.queue; console.log(`TEST_DATA_DIRECTORY ${temporaryRoot}`); }
}

run().then(() => app.exit(0), error => { console.error(error.stack || error); app.exit(1); });
