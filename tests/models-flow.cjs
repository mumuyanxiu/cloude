'use strict';
// Real renderer/preload/IPC; model discovery and chats use explicit fixtures.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { app, dialog } = require('electron');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
  const started = Date.now();
  while (Date.now() - started < 10000) { if (await check()) return; await pause(30); }
  throw new Error(`Timed out: ${label}`);
}
async function run() {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-models-flow-'));
  process.env.CLOUDE_TEST = '1'; process.env.CLOUDE_DATA = temporaryRoot;
  const main = require('../electron/main.cjs');
  const configuration = { host: 'fixture-models', port: 22, username: 'tester', authType: 'agent', workspace: '/project', claudePath: 'claude', autoConnect: true };
  await main.store.save({ connection: configuration, projects: ['a', 'b'].map(id => ({ id, name: `Project ${id}`, path: `/project/${id}`, connectionKey: 'tester@fixture-models:22:/project' })), conversations: [], settings: { activeProjectId: 'a', durableTasks: false } });
  main.remote.clientFactory = () => { throw new Error('Real SSH forbidden'); };
  main.remote.connect = async () => ({ home: '/home/tester', workspace: '/project', hostname: 'fixture-models', claudeAvailable: true });
  main.remote.disconnect = async () => main.remote._emit({ kind: 'connection', status: 'disconnected' });
  main.remote.openProject = async path => ({ path, name: path });
  main.remote.listFiles = async () => [];
  main.remote.listSessions = async () => ({ sessions: [] });
  main.remote.getUsage = async () => ({ available: false, limits: [], fetchedAt: Date.now() });
  dialog.showMessageBox = async () => { throw new Error('Unexpected dialog'); };
  const calls = { models: [], chat: [] }; let failure = false; let delayed;
  const fable = { value: 'fable', displayName: 'Fable 5.1', description: 'Fixture official display name', supportsEffort: true, supportedEffortLevels: ['low', 'high'] };
  let rows = [fable, { value: 'future-model', displayName: 'Future model', description: '', supportsEffort: false }];
  main.remote.getModels = async projectPath => {
    calls.models.push(projectPath);
    if (failure) throw new Error('模拟模型查询失败');
    if (delayed && projectPath === '/project/a') return new Promise(resolve => { delayed.resolve = resolve; });
    return { models: projectPath === '/project/b' ? [{ value: 'provider/b', displayName: 'Project B model', description: '' }] : rows, fetchedAt: Date.now() };
  };
  main.remote.startChat = async options => { calls.chat.push(options); return { jobId: options.jobId }; };
  const window = await main.ready; window.webContents.setBackgroundThrottling(false);
  const evaluate = code => window.webContents.executeJavaScript(code);
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const select = (label, value) => evaluate(`(() => { const e=document.querySelector('select[aria-label="'+${JSON.stringify(label)}+'"]'); e.value=${JSON.stringify(value)}; e.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  const options = () => evaluate(`Array.from(document.querySelector('select[aria-label="Claude 模型"]').options).map(e=>({value:e.value,text:e.textContent}))`);
  const status = () => evaluate('document.querySelector(".model-catalog-status")?.textContent');
  const refresh = () => click('[aria-label="刷新远端模型列表"]');
  const ready = () => until(async () => (await status()) === '模型列表来自远端 Claude Code', 'model list');
  const checks = [];
  const check = async (name, action) => { await action(); checks.push(name); console.log(`PASS ${name}`); };
  await ready();
  await check('model dropdown uses remote labels and future IDs without adding local presets', async () => {
    assert.deepEqual((await options()).map(e => e.value), ['', 'fable', 'future-model', 'custom']);
    assert.equal((await options())[1].text, 'Fable 5.1');
    assert.ok(calls.models.includes('/project/a'));
    await select('Claude 模型', 'fable');
    assert.deepEqual(await evaluate(`Array.from(document.querySelector('select[aria-label="Claude 思考强度"]').options).map(e=>e.value)`), ['', 'low', 'high']);
    await select('Claude 思考强度', 'high');
    await evaluate(`(() => { const e=document.querySelector('.composer textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'Fixture only'); e.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    await click('[aria-label="发送消息"]'); await until(() => calls.chat.length === 1, 'Fable request');
    assert.equal(calls.chat[0].model, 'fable'); assert.equal(calls.chat[0].effort, 'high');
    assert.equal(await evaluate(`document.querySelector('[aria-label="Claude 模型"]').disabled`), true);
    main.remote._emit({ kind: 'chat', jobId: calls.chat[0].jobId, type: 'event', event: { type: 'result', subtype: 'success', result: 'Model selection fixture complete.', session_id: 'fixture-model-session' } });
    main.remote._emit({ kind: 'chat', jobId: calls.chat[0].jobId, type: 'exit', code: 0 });
    await until(() => evaluate(`!document.querySelector('[aria-label="Claude 模型"]').disabled`), 'chat ended');
    await select('Claude 模型', 'future-model');
    assert.equal(await evaluate(`document.querySelector('[aria-label="Claude 思考强度"]').value`), '');
  });
  await check('dynamic selection persists across restart instead of being reset by a fixed allowlist', async () => {
    await until(async () => (await main.store.load()).settings.model === 'future-model', 'selection saved');
    await main.store.queue; await window.loadFile(path.resolve(__dirname, '..', 'dist', 'index.html')); await ready();
    assert.equal(await evaluate(`document.querySelector('[aria-label="Claude 模型"]').value`), 'future-model');
  });
  await check('failure removes obsolete rows, preserves selection visibly and allows retry', async () => {
    failure = true; await refresh();
    await until(async () => (await status()).includes('模拟模型查询失败'), 'visible lookup failure');
    assert.deepEqual((await options()).map(e => e.value), ['', 'future-model', 'custom']);
    assert.ok((await options())[1].text.includes('未在远端列表中'));
    failure = false; rows = [...rows, { value: 'brand-new', displayName: 'New remote release', description: '' }];
    await refresh(); await ready(); assert.ok((await options()).some(e => e.value === 'brand-new'));
  });
  await check('late results from another project cannot replace the current model list', async () => {
    await select('Claude 模型', ''); delayed = {};
    await refresh(); await until(() => !!delayed.resolve, 'delayed lookup');
    await click('.project-item[title="/project/b"]'); await ready();
    delayed.resolve({ models: [{ value: 'stale-a', displayName: 'Stale A', description: '' }], fetchedAt: Date.now() });
    delayed = null; await pause(100);
    assert.deepEqual((await options()).map(e => e.value), ['', 'provider/b', 'custom']);
  });
  await check('disconnect clears discovered models and disables refresh', async () => {
    main.remote._emit({ kind: 'connection', status: 'disconnected' });
    await until(async () => (await status()) === '连接后读取远端模型列表', 'disconnected list');
    assert.deepEqual((await options()).map(e => e.value), ['', 'custom']);
    assert.equal(await evaluate(`document.querySelector('[aria-label="刷新远端模型列表"]').disabled`), true);
  });
  // A reconnect must fetch again. Use it to capture the finished model controls.
  await click('.connection-button');
  await evaluate(`document.querySelector('.connection-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))`);
  await ready(); await click('.project-item[title="/project/a"]'); await ready(); await select('Claude 模型', 'fable');
  await until(async () => (await options()).some(item => item.value === 'fable'), 'Fable after reconnect');
  await select('Claude 模型', 'fable');
  await until(() => evaluate(`document.querySelector('[aria-label="Claude 模型"]').value === 'fable' && document.querySelector('.model-catalog-status').textContent === '模型列表来自远端 Claude Code'`), 'settled controls');
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'); await pause(100);
  const output = path.resolve(__dirname, '..', 'output'); await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, 'models-fixture.png'), (await window.webContents.capturePage()).toPNG());
  await fs.writeFile(path.join(output, 'models-flow.json'), JSON.stringify({ passed: checks.length, checks, realSSH: false }, null, 2));
  await main.store.queue; console.log(`PASS ${checks.length} model catalog flows`);
}
run().then(() => app.exit(0), error => { console.error(error.stack || error); app.exit(1); });
