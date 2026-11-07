'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { app, clipboard, ClipboardItem, dialog, shell } = require('electron');
const { LocalSftp } = require('./helpers/local-sftp.cjs');
const { StateStore } = require('../electron/state.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) { for (let i = 0; i < 250; i++) { if (await check()) return; await pause(40); } throw new Error('Timed out: ' + label); }

async function run() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cloude-features-flow-'));
  process.env.CLOUDE_TEST = '1'; process.env.CLOUDE_DATA = path.join(root, 'state');
  const original = [];
  for (const item of await clipboard.read()) { const values = {}; for (const type of item.types) { try { values[type] = await item.getType(type); } catch {} } if (Object.keys(values).length) original.push(new ClipboardItem(values)); }
  const projectPath = '/home/tester/work/project';
  const sftp = new LocalSftp(path.join(root, 'remote'));
  await fs.mkdir(sftp.native(projectPath), { recursive: true });
  await fs.mkdir(sftp.native(projectPath + '/results'));
  await fs.writeFile(sftp.native(projectPath + '/main.py'), 'print("fixture")\n');
  await fs.writeFile(sftp.native(projectPath + '/results/report.txt'), 'bundle fixture');
  const png = await fs.readFile(path.resolve('assets/claude-icon.png'));
  const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
  let clipboardPng;
  await fs.writeFile(sftp.native(projectPath + '/figure.png'), png);
  const config = { host: 'fixture', port: 22, username: 'tester', authType: 'agent', workspace: '/home/tester/work', claudePath: 'claude', autoConnect: true };
  await new StateStore(process.env.CLOUDE_DATA).save({ connection: config, projects: [{ id: 'project', name: 'project', path: projectPath, connectionKey: 'tester@fixture:22:/home/tester/work' }], conversations: [], settings: { durableTasks: false } });
  // Exercise the fastest startup path only after every fixture exists. Keep
  // mock installation synchronous until main.ready yields to the renderer.
  await app.whenReady();
  const main = require('../electron/main.cjs');
  let realSshAttempts = 0;
  main.remote.clientFactory = () => { realSshAttempts++; throw new Error('Real user SSH forbidden'); };
  main.remote.connect = async () => { main.remote.client = {}; main.remote.sftp = sftp; main.remote.home = '/home/tester'; main.remote.workspace = '/home/tester/work'; main.remote.workspaceInput = '/home/tester/work'; return { home: '/home/tester', workspace: '/home/tester/work', hostname: 'fixture', claudeAvailable: true }; };
  main.remote.disconnect = async () => { main.remote._emit({ kind: 'connection', status: 'disconnected' }); };
  main.remote.listSessions = async () => ({ sessions: [] });
  main.remote.getModels = async () => ({ models: ['sonnet', 'opus', 'fable'].map(value => ({ value, displayName: value, description: 'Fixture model', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] })), fetchedAt: Date.now() });
  main.remote.getUsage = async () => ({ available: false, limits: [], fetchedAt: Date.now() });
  const calls = { chat: [], terminal: [], resize: [], input: [], external: [], opened: [], replies: [], stops: [] };
  main.remote.startChat = async options => { calls.chat.push(options); setTimeout(() => { main.remote._emit({ kind: 'chat', jobId: options.jobId, type: 'event', event: { type: 'result', subtype: 'success', result: '已查看图片。', session_id: 'fixture-session' } }); main.remote._emit({ kind: 'chat', jobId: options.jobId, type: 'exit', code: 0 }); }, 50); return { jobId: options.jobId }; };
  main.remote.openTerminal = async options => { calls.terminal.push(options); setTimeout(() => main.remote._emit({ kind: 'terminal', jobId: options.jobId, type: 'data', data: options.login ? 'Open https://claude.ai/oauth/authorize?fixture=1\r\nCode: ' : '\x1b[32mfixture shell\x1b[0m\r\n' }), 50); return { jobId: options.jobId }; };
  main.remote.resizeTerminal = async options => { calls.resize.push(options); };
  main.remote.writeJob = async (jobId, data) => { calls.input.push({ jobId, data }); };
  main.remote.stopJob = async jobId => { calls.stops.push(jobId); main.remote._emit({ kind: 'terminal', jobId, type: 'exit', code: 0 }); };
  shell.openExternal = async url => { calls.external.push(url); };
  shell.openPath = async file => { calls.opened.push(file); return ''; };
  const zipPath = path.join(root, 'results.zip');
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: zipPath });
  dialog.showMessageBoxSync = () => 1;
  const window = await main.ready; window.webContents.setBackgroundThrottling(false);
  const evaluate = code => window.webContents.executeJavaScript(code).catch(error => { throw new Error(`${error.message}: ${code.slice(0, 200)}`); });
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const exists = selector => evaluate(`!!document.querySelector(${JSON.stringify(selector)})`);
  const fill = async (selector, value) => { await evaluate(`(() => { const e=document.querySelector(${JSON.stringify(selector)}); const p=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(p,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true})); })()`); await pause(50); };
  const invoke = (method, value) => evaluate(`window.workspace[${JSON.stringify(method)}](${value === undefined ? '' : JSON.stringify(value)})`);
  const checks = [];
  const check = async (name, action) => { console.log('CHECK ' + name); await action(); checks.push(name); console.log('PASS ' + name); };
  try {
    await until(() => evaluate('document.querySelector(".connection-button").textContent === "已连接"'), 'connection');
    await check('native clipboard image becomes an attachment and image-only send uploads exact bytes', async () => {
      clipboard.clear(); // Remove pre-existing Windows file-drop formats before the image fixture.
      await clipboard.write([new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) })]);
      const copied = (await clipboard.read()).find(item => item.types.includes('image/png'));
      clipboardPng = Buffer.from(await (await copied.getType('image/png')).arrayBuffer());
      await click('[aria-label="粘贴图片或文件"]');
      await until(() => exists('.attachment-chip img'), 'clipboard preview');
      assert.equal(await evaluate('document.querySelector("[aria-label=发送消息]").disabled'), false);
      await click('[aria-label="发送消息"]');
      await until(() => calls.chat.length === 1, 'image send');
      const state = await main.store.load();
      await until(async () => (await main.store.load()).conversations[0]?.messages[0]?.attachments?.length === 1, 'attachment persistence');
      const attachment = (await main.store.load()).conversations[0].messages[0].attachments[0];
      assert.equal(digest(await fs.readFile(sftp.native(attachment.path))), digest(clipboardPng));
      assert.ok(calls.chat[0].prompt.includes(attachment.path));
      assert.equal(attachment.preview, undefined);
      await until(() => exists('.user-message .remote-image img'), 'sent image preview');
      assert.equal(await evaluate('document.querySelector(".statusbar").textContent.includes("上传")'), false, 'completed image upload must clear the footer');
    });
    await check('image preview supports native clipboard copy and local application opening', async () => {
      await click('.user-message .remote-image button');
      await until(() => exists('.image-preview img'), 'preview');
      await evaluate('[...document.querySelectorAll(".media-actions button")].find(b=>b.textContent.includes("复制图片")).click()');
      await until(() => evaluate('document.querySelector(".media-actions").textContent.includes("已复制")'), 'copy');
      assert.ok((await clipboard.read()).some(item => item.types.includes('image/png')));
      await evaluate('[...document.querySelectorAll(".media-actions button")].find(b=>b.textContent.includes("本地应用打开")).click()');
      await until(() => calls.opened.length === 1, 'local open');
      assert.equal(digest(await fs.readFile(calls.opened[0])), digest(clipboardPng));
      await click('[aria-label="关闭窗口"]');
    });
    await check('paste event carries a virtual image through the isolated preload and leaves text paste intact', async () => {
      await evaluate(`(() => { const input=document.querySelector('.composer textarea'); const data=new DataTransfer(); data.items.add(new File([new Uint8Array(${JSON.stringify([...png])})], 'clipboard.png', {type:'image/png'})); input.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true})); })()`);
      await until(() => exists('.attachment-chip img'), 'paste event attachment');
      await click('.attachment-chip button');
      assert.equal(await evaluate(`(() => { const data=new DataTransfer();data.setData('text/plain','hello');const event=new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true});document.querySelector('.composer textarea').dispatchEvent(event);return event.defaultPrevented;})()`), false);
    });
    await check('failed attachment uploads clear progress, retain the attachment and ignore late events', async () => {
      await until(() => exists('[aria-label="发送消息"]'), 'idle chat before failure');
      await clipboard.write([new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) })]);
      await click('[aria-label="粘贴图片或文件"]');
      await until(() => exists('.attachment-chip img'), 'attachment staged before failure');
      const uploadFile = main.remote.upload;
      const chatCount = calls.chat.length;
      let rejectUpload;
      main.remote.upload = async () => {
        main.remote._emit({ kind: 'transfer', direction: 'upload', name: 'failed-attachment.png', transferred: 1, total: 2 });
        return new Promise((_resolve, reject) => { rejectUpload = reject; });
      };
      try {
        await click('[aria-label="发送消息"]');
        await until(() => evaluate('document.querySelector(".statusbar").textContent.includes("failed-attachment.png · 50%")'), 'active upload remains visible');
        rejectUpload(new Error('fixture attachment upload failure'));
        await until(() => evaluate('document.querySelector(".toast.error")?.textContent.includes("附件未发送")'), 'attachment failure shown');
        assert.equal(calls.chat.length, chatCount, 'failed upload must not send a chat');
        assert.ok(await exists('.attachment-chip img'), 'failed attachment remains available to retry');
        assert.equal(await evaluate('document.querySelector(".statusbar").textContent.includes("上传")'), false);
        main.remote._emit({ kind: 'transfer', direction: 'upload', name: 'late-attachment.png', transferred: 2, total: 2 });
        await pause(80);
        assert.equal(await evaluate('document.querySelector(".statusbar").textContent.includes("late-attachment.png")'), false);
      } finally {
        main.remote.upload = uploadFile;
      }
      await click('.attachment-chip button');
      await click('[aria-label="关闭提示"]');
    });
    await check('file references search and directory bundle use the real SFTP-backed implementation', async () => {
      await click('[aria-label="搜索并引用项目文件"]');
      await fill('[aria-label="搜索项目文件"]', 'main.py');
      await until(() => evaluate('document.querySelector(".file-picker-list")?.textContent.includes("main.py")'), 'file search');
      await click('.file-picker-list button');
      assert.ok(await exists('.references'));
      const bundle = await invoke('downloadBundle', { path: projectPath + '/results' });
      assert.equal(bundle.files, 1); assert.equal((await fs.readFile(zipPath)).subarray(0, 2).toString(), 'PK');
    });
    await check('Windows Explorer file clipboard preserves a Unicode filename', async () => {
      const file = path.join(root, '测试日志.txt'); await fs.writeFile(file, 'file clipboard fixture');
      const script = '[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false); Add-Type -AssemblyName System.Windows.Forms; $items = New-Object System.Collections.Specialized.StringCollection; foreach ($p in (ConvertFrom-Json ([Console]::In.ReadToEnd()))) { [void]$items.Add($p) }; [System.Windows.Forms.Clipboard]::SetFileDropList($items)';
      const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', script], { input: JSON.stringify([file]), encoding: 'utf8', windowsHide: true });
      assert.equal(result.status, 0, result.stderr);
      await click('[aria-label="粘贴图片或文件"]');
      await until(() => evaluate('document.querySelector(".attachment-chip")?.textContent.includes("测试日志.txt")'), 'Unicode copied file');
      await click('.attachment-chip button');
    });
    await check('xterm receives raw ANSI data, resizes, accepts input, and opens auth in local browser', async () => {
      await click('[aria-label="打开交互终端"]');
      await until(() => exists('.xterm-screen'), 'xterm'); await until(() => calls.resize.length > 0, 'terminal resize');
      await evaluate('document.querySelector(".xterm-helper-textarea").focus()');
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'a' }); window.webContents.sendInputEvent({ type: 'char', keyCode: 'a' }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'a' });
      await until(() => calls.input.some(item => item.data === 'a'), 'raw terminal input');
      await click('[aria-label="关闭交互终端"]');
      await click('[aria-label="登录远端 Claude"]');
      await until(() => exists('.terminal-links button'), 'auth link');
      await click('.terminal-links button');
      assert.equal(calls.external.at(-1), 'https://claude.ai/oauth/authorize?fixture=1');
      assert.equal(calls.terminal.at(-1).login, true);
      await click('[aria-label="关闭交互终端"]');
    });
    await check('durable tasks survive UI disconnect, repeated attach and completed replay without reexecution', async () => {
      let task; let starts = 0; let polls = 0; const events = [];
      main.remote.startPersistentChat = async options => {
        starts++;
        assert.equal(options.model, 'sonnet'); assert.equal(options.effort, 'medium');
        task = { jobId: options.jobId, conversationId: options.conversationId, projectPath, title: 'Fixture question', state: 'waiting', createdAt: Date.now(), updatedAt: Date.now(), pendingRequests: [{ type: 'control_request', request_id: 'question', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions: [{ question: 'Choose a format', options: [{ label: 'PNG' }, { label: 'JPEG' }] }] } } }] };
        events.push({ type: 'event', event: { type: 'system', subtype: 'init', session_id: 'durable-session' } });
        return { jobId: options.jobId };
      };
      main.remote.listTasks = async () => ({ tasks: [task] });
      main.remote.pollTask = async options => { polls++; return { task, events: events.slice(options.cursor), cursor: events.length, more: false }; };
      main.remote.replyTask = async options => { calls.replies.push(options); task = { ...task, state: 'completed', pendingRequests: [], sessionId: 'durable-session' }; events.push({ type: 'event', event: { type: 'assistant', message: { content: [{ type: 'text', text: 'Answered once.' }] } } }, { type: 'event', event: { type: 'result', subtype: 'success', session_id: 'durable-session' } }); };
      await click('.composer-feature-options input');
      await evaluate(`(() => { for (const [label,value] of [['Claude 模型','sonnet'],['Claude 思考强度','medium']]) { const e=document.querySelector('select[aria-label="'+label+'"]');e.value=value;e.dispatchEvent(new Event('change',{bubbles:true})); } })()`);
      await fill('.composer textarea', 'Ask a fixture question'); await click('[aria-label="发送消息"]');
      await until(() => exists('.request-card'), 'question card');
      assert.equal(await evaluate('document.querySelector(".request-actions").textContent.includes("本项目始终允许")'), false);
      await click('[aria-label="远端任务与恢复"]');
      await until(() => exists('.task-list .secondary-button'), 'running task list');
      await click('.task-list .secondary-button');
      const beforeRepeatedAttach = polls;
      await until(() => polls > beforeRepeatedAttach, 'same task continues polling after attach');
      await invoke('disconnect');
      await until(() => evaluate('document.querySelector(".connection-button").textContent === "连接设备"'), 'disconnected UI');
      assert.equal(await exists('.request-card'), false);
      await click('.connection-button');
      await click('.modal form .primary-button');
      await until(() => evaluate('document.querySelector(".connection-button").textContent === "已连接"'), 'reconnected UI');
      await until(() => exists('.request-card'), 'restored question card');
      const beforeReconnect = polls;
      await until(() => polls > beforeReconnect, 'recovered task continues polling');
      assert.equal(starts, 1, 'reconnect must not resubmit the prompt');
      await click('.request-card input[type=radio]');
      await click('.request-actions .primary-button');
      await until(() => calls.replies.length === 1, 'answer submitted');
      assert.equal(calls.replies[0].answers['Choose a format'], 'PNG');
      assert.equal(calls.replies[0].scope, 'once');
      await until(() => evaluate('document.querySelector(".messages").textContent.includes("Answered once.")'), 'durable completion');
      await until(async () => (await main.store.load()).conversations.some(c => c.task?.finished), 'finished state');
      const saved = await main.store.load();
      assert.equal(saved.conversations.at(-1).messages.filter(m => m.content.includes('Answered once.')).length, 1);
      await click('[aria-label="远端任务与恢复"]');
      await until(() => exists('.task-list .secondary-button'), 'completed task list');
      await click('.task-list .secondary-button');
      await until(() => evaluate('document.querySelector(".messages").textContent.includes("Answered once.")'), 'completed task replay');
      await until(async () => (await main.store.load()).conversations.at(-1).task?.finished, 'replay finished state');
      assert.equal((await main.store.load()).conversations.at(-1).messages.filter(m => m.content.includes('Answered once.')).length, 1);
      assert.equal(starts, 1);
      await until(async () => !(await exists('.request-card')) && await exists('[aria-label="发送消息"]'), 'completed UI');
      await pause(150);
      await fs.writeFile(path.resolve('output/features-fixture.png'), (await window.webContents.capturePage()).toPNG());
      await evaluate(`(() => { for (const label of ['Claude 模型','Claude 思考强度']) { const e=document.querySelector('select[aria-label="'+label+'"]');e.value='';e.dispatchEvent(new Event('change',{bubbles:true})); } })()`);
    });
    await check('tool approvals preserve once, deny and project scopes; failed submission can be retried', async () => {
      const requests = [
        { type: 'control_request', request_id: 'mcp-once', request: { subtype: 'can_use_tool', tool_name: 'mcp__fixture__inspect', input: { target: 'sample' } } },
        { type: 'control_request', request_id: 'read-deny', request: { subtype: 'can_use_tool', tool_name: 'Read', input: { file_path: '/outside/diagram.png' }, blocked_path: '/outside/diagram.png', decision_reason: 'fixture path requires approval' } },
        { type: 'control_request', request_id: 'mcp-project', request: { subtype: 'can_use_tool', tool_name: 'mcp__fixture__inspect', input: { target: 'sample' } } },
      ];
      let task; const events = []; const replies = []; let index = 0; let fail = true;
      main.remote.startPersistentChat = async options => {
        assert.equal(options.allowCommands, undefined); assert.equal(options.askCommands, undefined);
        task = { jobId: options.jobId, conversationId: options.conversationId, projectPath, title: 'Permission fixture', state: 'waiting', createdAt: Date.now(), updatedAt: Date.now(), pendingRequests: [requests[index]] };
        return { jobId: task.jobId };
      };
      main.remote.listTasks = async () => ({ tasks: task ? [task] : [] });
      main.remote.pollTask = async options => ({ task, events: events.slice(options.cursor), cursor: events.length, more: false });
      main.remote.replyTask = async options => {
        if (options.scope === 'project' && fail) { fail = false; throw new Error('fixture retry'); }
        replies.push(options); index++;
        task = { ...task, state: index < requests.length ? 'waiting' : 'completed', pendingRequests: index < requests.length ? [requests[index]] : [] };
        if (task.state === 'completed') events.push({ type: 'event', event: { type: 'result', subtype: 'success', result: 'Permissions complete.' } });
      };
      await fill('.composer textarea', 'Check permissions'); await click('[aria-label="发送消息"]');
      await until(() => exists('.request-card'), 'tool permission card');
      assert.ok(await evaluate('document.querySelector(".request-card").textContent.includes("所有调用")'));
      await evaluate('[...document.querySelectorAll(".request-actions button")].find(b=>b.textContent==="仅允许这一次").click()');
      await until(() => evaluate('document.querySelector(".request-card")?.textContent.includes("/outside/diagram.png")'), 'read permission details');
      assert.equal(replies[0].scope, 'once'); assert.equal(replies[0].allow, true);
      assert.ok(await evaluate('document.querySelector(".request-card").textContent.includes("fixture path requires approval")'));
      await evaluate('[...document.querySelectorAll(".request-actions button")].find(b=>b.textContent==="拒绝").click()');
      await until(() => evaluate('document.querySelector(".request-card")?.textContent.includes("mcp__fixture__inspect")'), 'project permission card');
      assert.equal(replies[1].scope, 'once'); assert.equal(replies[1].allow, false);
      await evaluate('[...document.querySelectorAll(".request-actions button")].find(b=>b.textContent==="本项目始终允许此工具").click()');
      await until(() => evaluate('document.querySelector(".request-card .feature-error")?.textContent.includes("fixture retry")'), 'retry error');
      assert.equal(await evaluate('[...document.querySelectorAll(".request-actions button")].some(b=>b.disabled)'), false);
      const cardLayout = await evaluate('(() => { const card=document.querySelector(".request-card").getBoundingClientRect(); const actions=document.querySelector(".request-actions").getBoundingClientRect(); return {top:card.top,bottom:card.bottom,height:card.height,actionsBottom:actions.bottom,viewport:innerHeight}; })()');
      assert.ok(cardLayout.height > 100 && cardLayout.top >= 0 && cardLayout.bottom <= cardLayout.viewport, JSON.stringify(cardLayout));
      assert.ok(cardLayout.actionsBottom <= cardLayout.bottom, 'approval choices must be visible without clipping');
      await window.webContents.capturePage();
      await pause(150);
      await fs.writeFile(path.resolve('output/permissions-fixture.png'), (await window.webContents.capturePage()).toPNG());
      await evaluate('[...document.querySelectorAll(".request-actions button")].find(b=>b.textContent==="本项目始终允许此工具").click()');
      await until(() => replies.length === 3, 'project permission submitted');
      assert.equal(replies[2].scope, 'project'); assert.equal(replies[2].allow, true);
      assert.equal(replies[2].projectPath, projectPath); assert.equal(replies[2].requestId, 'mcp-project');
      await until(() => evaluate('document.querySelector(".messages").textContent.includes("Permissions complete.")'), 'permissions completion');
    });
    assert.equal(realSshAttempts, 0, 'All connections must use the isolated remote fixture');
    const report = { passed: checks.length, checks, actualElectronIPC: true, actualClipboard: true, sftpBoundary: 'LocalSftp', realSshAttempts, actualClaudeInference: false };
    await fs.writeFile(path.resolve('output/features-flow.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } finally {
    if (original.length) await clipboard.write(original).catch(() => {}); else clipboard.clear();
    main.remote.disconnect = async () => {};
  }
}
run().then(() => app.exit(0)).catch(error => { console.error(error.stack || error); app.exit(1); });
