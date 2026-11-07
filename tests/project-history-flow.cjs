'use strict';
// Real renderer/preload/IPC. Remote history and model requests are isolated fixtures.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { app, dialog, shell } = require('electron');
const { StateStore } = require('../electron/state.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
  for (let i = 0; i < 250; i++) { if (await check()) return; await pause(30); }
  throw new Error('Timed out: ' + label);
}

async function run() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cloude-project-history-'));
  process.env.CLOUDE_TEST = '1'; process.env.CLOUDE_DATA = path.join(root, 'state');
  const config = { host: 'fixture-history', port: 22, username: 'fixture', authType: 'agent', workspace: '/project', claudePath: 'claude' };
  const connectionKey = 'fixture@fixture-history:22:/project';
  const projects = ['a', 'b'].map(name => ({ id: name, name: 'Project ' + name.toUpperCase(), path: '/project/' + name, connectionKey }));
  const local = { id: 'local-a', projectId: 'a', sessionId: 'session-a-local', title: '已有本地对话', updatedAt: 10,
    messages: [{ id: 'local-message', role: 'assistant', content: '保留本地工具和聊天内容' }] };
  await new StateStore(process.env.CLOUDE_DATA).save({ connection: config, projects, conversations: [local],
    settings: { activeProjectId: 'a', activeConversationId: local.id, durableTasks: false } });
  await app.whenReady();
  const main = require('../electron/main.cjs');
  const sessions = {
    '/project/a': [{ sessionId: 'session-a-local', title: '服务器上的旧标题', updatedAt: 30 }, { sessionId: 'session-a-old', title: 'A 的远端历史', updatedAt: 20 }],
    '/project/b': [{ sessionId: 'session-b', title: 'B 的远端历史', updatedAt: 25 }],
    '/project/c': [{ sessionId: 'session-c', title: 'C 的远端历史', updatedAt: 40 }],
  };
  const calls = { lists: [], reads: [], chat: [] };
  let failList = false, failRead = false, delayedList = null;
  main.remote.clientFactory = () => { throw new Error('Real SSH forbidden'); };
  main.remote.connect = async () => ({ home: '/home/fixture', workspace: '/project', hostname: 'fixture-history', claudeAvailable: true, claudeVersion: 'fixture-only' });
  main.remote.disconnect = async () => {};
  main.remote.listFiles = async () => [];
  main.remote.listTasks = async () => ({ tasks: [] });
  main.remote.getUsage = async () => ({ available: false, limits: [], fetchedAt: Date.now() });
  main.remote.openProject = async value => ({ path: value, name: path.posix.basename(value) });
  main.remote.listSessions = async projectPath => {
    calls.lists.push(projectPath);
    if (failList) throw new Error('模拟历史列表读取失败');
    if (delayedList && projectPath === '/project/a') return new Promise(resolve => { delayedList.resolve = resolve; });
    return { sessions: sessions[projectPath] || [] };
  };
  main.remote.readSession = async (projectPath, sessionId) => {
    calls.reads.push({ projectPath, sessionId });
    if (failRead) throw new Error('模拟历史内容读取失败');
    return { sessionId, title: 'loaded', updatedAt: 20, truncated: false, notice: '继续发送消息将使用原会话。',
      messages: [{ id: sessionId + '-message', role: 'assistant', content: '已加载 ' + sessionId }] };
  };
  main.remote.startChat = async options => {
    calls.chat.push(options);
    setTimeout(() => {
      main.remote._emit({ kind: 'chat', jobId: options.jobId, type: 'event', event: { type: 'result', result: 'fixture complete' } });
      main.remote._emit({ kind: 'chat', jobId: options.jobId, type: 'exit', code: 0 });
    }, 30);
    return { jobId: options.jobId };
  };
  const unexpected = () => { throw new Error('Unexpected external UI'); };
  dialog.showOpenDialog = unexpected; dialog.showSaveDialog = unexpected;
  dialog.showMessageBox = unexpected; dialog.showMessageBoxSync = unexpected; shell.openExternal = unexpected;
  const window = await main.ready; window.webContents.setBackgroundThrottling(false);
  const evaluate = code => window.webContents.executeJavaScript(code).catch(error => { throw new Error(`${code}\n${error.message}`); });
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const fill = async (selector, value) => {
    await evaluate(`(() => { const e=document.querySelector(${JSON.stringify(selector)}); const p=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(p,'value').set.call(e,${JSON.stringify(value)}); e.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    await pause(40);
  };
  const stored = () => evaluate('window.workspace.loadState()');
  const selectProject = name => click(`.project-item[title="/project/${name}"]`);
  const selectSession = session => click(`.conversation-item[data-session-id="${session}"]`);
  const checks = [];
  const check = async (name, action) => { await action(); checks.push(name); console.log('PASS ' + name); };

  await check('connecting automatically lists project history without a modal or overwriting local messages', async () => {
    await until(() => evaluate('document.querySelectorAll(".conversation-item").length === 2'), 'automatic history list');
    assert.deepEqual(calls.lists, ['/project/a']); assert.equal(calls.reads.length, 0);
    assert.equal(await evaluate('!!document.querySelector(".modal")'), false);
    assert.ok(await evaluate('document.querySelector(".messages").textContent.includes("保留本地工具和聊天内容")'));
    assert.equal((await stored()).conversations.find(c => c.id === local.id).title, local.title);
  });
  await check('clicking remote history loads it once and resumes the original project and session', async () => {
    await selectSession('session-a-old');
    await until(() => evaluate('document.querySelector(".messages")?.textContent.includes("已加载 session-a-old")'), 'history body');
    await fill('textarea', '继续此会话'); await click('[aria-label="发送消息"]');
    await until(() => calls.chat.length === 1, 'session continuation');
    assert.equal(calls.chat[0].projectPath, '/project/a'); assert.equal(calls.chat[0].sessionId, 'session-a-old');
    await until(() => evaluate('!document.querySelector(".stop-button")'), 'finished model fixture');
    await click('[aria-label="刷新历史对话"]');
    await until(() => evaluate('!document.querySelector("[aria-label=刷新历史对话]").disabled'), 'refreshed list');
    assert.equal(calls.reads.filter(c => c.sessionId === 'session-a-old').length, 1);
    assert.equal(await evaluate('document.querySelectorAll(".conversation-item").length'), 2);
    assert.ok(await evaluate('document.querySelector(".messages").textContent.includes("继续此会话")'));
  });
  let newA, newB;
  await check('new conversations belong to the selected project and project switches isolate the lists', async () => {
    await click('.new-chat');
    await until(async () => !!(await stored()).conversations.find(c => c.projectId === 'a' && !c.sessionId), 'new A conversation saved');
    newA = (await stored()).conversations.find(c => c.projectId === 'a' && !c.sessionId);
    await selectProject('b');
    await until(() => evaluate('document.querySelectorAll(".conversation-item").length === 1 && !!document.querySelector("[data-session-id=session-b]")'), 'B-only conversations');
    await click('.new-chat');
    await until(async () => !!(await stored()).conversations.find(c => c.projectId === 'b' && !c.sessionId), 'new B conversation saved');
    newB = (await stored()).conversations.find(c => c.projectId === 'b' && !c.sessionId);
    assert.notEqual(newA.id, newB.id);
    await selectProject('a');
    await until(() => evaluate('document.querySelectorAll(".conversation-item").length === 3'), 'A conversation list restored');
    assert.equal(await evaluate('!!document.querySelector("[data-session-id=session-b]")'), false);
    assert.equal((await stored()).conversations.find(c => c.id === newA.id).projectId, 'a');
    assert.equal((await stored()).conversations.find(c => c.id === newB.id).projectId, 'b');
  });
  await check('list failures preserve local conversations and support retry without clearing the draft', async () => {
    failList = true; await fill('textarea', '保留草稿'); await click('[aria-label="刷新历史对话"]');
    await until(() => evaluate('document.querySelector(".history-sync-status.error")?.textContent.includes("模拟历史列表读取失败")'), 'visible list failure');
    assert.equal(await evaluate('document.querySelectorAll(".conversation-item").length'), 3);
    failList = false; await click('.history-sync-status.error button');
    await until(() => evaluate('!document.querySelector(".history-sync-status.error") && !document.querySelector("[aria-label=刷新历史对话]").disabled'), 'list retry');
    assert.equal(await evaluate('document.querySelector("textarea").value'), '保留草稿');
  });
  await check('a late list response cannot select or import conversations into another project', async () => {
    delayedList = {};
    await click('[aria-label="刷新历史对话"]'); await until(() => !!delayedList.resolve, 'delayed A list started');
    await selectProject('b');
    await until(() => evaluate('document.querySelector(".breadcrumb-project").textContent === "Project B"'), 'switched to B');
    delayedList.resolve({ sessions: [{ sessionId: 'stale-session', title: '过期结果', updatedAt: 99 }] }); delayedList = null;
    await pause(150);
    assert.equal((await stored()).conversations.some(c => c.sessionId === 'stale-session'), false);
    assert.equal(await evaluate('document.querySelectorAll(".conversation-item").length'), 2);
  });
  await check('history body errors are retryable and prevent sending before the original messages load', async () => {
    sessions['/project/a'].push({ sessionId: 'session-a-retry', title: '可重试的历史', updatedAt: 50 });
    await selectProject('a');
    await until(() => evaluate('!!document.querySelector("[data-session-id=session-a-retry]")'), 'new remote history');
    failRead = true; await selectSession('session-a-retry');
    await until(() => evaluate('document.querySelector(".history-load-status")?.textContent.includes("模拟历史内容读取失败")'), 'body failure');
    assert.equal(await evaluate('document.querySelector("[aria-label=发送消息]").disabled'), true);
    failRead = false; await click('.history-load-status button');
    await until(() => evaluate('document.querySelector(".messages")?.textContent.includes("已加载 session-a-retry")'), 'body retry');
  });
  await check('adding an existing project automatically lists and opens its history without an import dialog', async () => {
    await click('[aria-label="读取已有项目"]');
    await fill('.modal form input', 'Project C'); await fill('.modal form label:nth-of-type(2) input', '/project/c');
    await evaluate('[...document.querySelectorAll(".modal button")].find(e=>e.textContent.trim()==="打开项目").click()');
    await until(() => evaluate('document.querySelector(".messages")?.textContent.includes("已加载 session-c")'), 'added project history');
    assert.equal(await evaluate('!!document.querySelector(".modal")'), false);
    assert.equal(await evaluate('document.querySelectorAll(".conversation-item").length'), 1);
    await click('.new-chat');
    await until(async () => {
      const state = await stored(); const project = state.projects.find(p => p.path === '/project/c');
      return state.conversations.some(c => c.projectId === project.id && !c.sessionId);
    }, 'new conversation bound to added C project');
  });
  const output = path.resolve(__dirname, '..', 'output'); await fs.mkdir(output, { recursive: true });
  window.showInactive(); // Let Chromium composite the final state before visual verification.
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  window.webContents.invalidate(); await pause(150);
  await fs.writeFile(path.join(output, 'project-history-fixture.png'), (await window.webContents.capturePage()).toPNG());
  window.hide();
  await fs.writeFile(path.join(output, 'project-history-flow.json'), JSON.stringify({ passed: checks.length, checks, actualElectronIPC: true, realSSH: false, realClaude: false }));
  await main.store.queue;
}
run().then(() => app.exit(0), error => { console.error(error.stack || error); app.exit(1); });
