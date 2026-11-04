'use strict';

// Real renderer/preload/main IPC and Chromium keyboard input. SSH, Claude,
// terminal processes and account usage are fixtures; no real device is used.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const temporaryRoot = require('node:fs').mkdtempSync(path.join(os.tmpdir(), 'workspace-commands-flow-'));
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
  while (Date.now() - started < timeout) { if (await check()) return; await pause(30); }
  throw new Error(`Timed out: ${label}`);
}

async function run() {
  const workspace = '/home/fixture/claude-workspace';
  const project = `${workspace}/commands-fixture`;
  const config = { host: 'fixture-commands', port: 22, username: 'fixture', authType: 'key', privateKeyPath: 'C:/fixture/key', workspace, claudePath: 'claude', autoConnect: true };
  await fs.writeFile(path.join(dataDirectory, 'workspace.json'), JSON.stringify({
    connection: config,
    projects: [{ id: 'fixture-project', name: 'commands-fixture', path: project, connectionKey: `fixture@fixture-commands:22:${workspace}` }],
    conversations: [{ id: 'fixture-conversation', projectId: 'fixture-project', title: '已有会话', updatedAt: 1, messages: [{ id: 'fixture-message', role: 'assistant', content: '这段已有历史不能被清除。' }] }],
    settings: { activeProjectId: 'fixture-project', activeConversationId: 'fixture-conversation' },
  }));
  const unexpected = () => { throw new Error('Unexpected native UI in commands fixture test'); };
  dialog.showOpenDialog = unexpected; dialog.showSaveDialog = unexpected;
  dialog.showMessageBox = unexpected; dialog.showMessageBoxSync = unexpected;
  shell.openExternal = unexpected; shell.showItemInFolder = unexpected;
  const calls = { connect: 0, chat: [], commands: [], writes: [] };
  const main = require('../electron/main.cjs');
  main.remote.clientFactory = () => { throw new Error('Real SSH forbidden in commands-flow test'); };
  main.remote.connect = async () => { calls.connect++; return { home: '/home/fixture', workspace, hostname: config.host, claudeAvailable: true, claudeVersion: 'fixture-only' }; };
  main.remote.disconnect = async () => {};
  main.remote.listFiles = async () => [{ name: 'main.py', path: `${project}/main.py`, type: 'file', size: 10, mtime: 100 }];
  main.remote.getUsage = async () => ({ available: false, limits: [], fetchedAt: Date.now(), message: '模拟设备未提供额度数据' });
  main.remote.startChat = async options => { calls.chat.push(options); return { jobId: options.jobId }; };
  main.remote.runCommand = async options => { calls.commands.push(options); return { jobId: options.jobId }; };
  main.remote.writeJob = async (jobId, data) => { calls.writes.push({ jobId, data }); };
  const window = await main.ready;
  window.webContents.setBackgroundThrottling(false);
  const evaluate = async code => { try { return await window.webContents.executeJavaScript(code); } catch (error) { throw new Error(`Renderer evaluation failed: ${code}\n${error.message}`); } };
  const click = selector => evaluate(`(() => { const e=document.querySelector(${JSON.stringify(selector)}); if(!e) throw new Error('Missing target '+${JSON.stringify(selector)}); e.click(); })()`);
  const clickText = text => evaluate(`(() => { const e=[...document.querySelectorAll('.modal button')].find(e=>e.textContent.trim()===${JSON.stringify(text)}); if(!e) throw new Error('Missing button '+${JSON.stringify(text)}); e.click(); })()`);
  const chatInput = 'textarea[aria-label="发送给 Claude 的消息"]';
  const shellInput = '.terminal-input input';
  const chatMenu = '[role="listbox"][aria-label="Claude 常用命令"]';
  const shellMenu = '[role="listbox"][aria-label="终端常用命令"]';
  const exists = selector => evaluate(`!!document.querySelector(${JSON.stringify(selector)})`);
  const value = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).value`);
  const focus = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);
  const key = async (keyCode, modifiers = []) => {
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    if (keyCode === 'Return' && !modifiers.includes('control') && !modifiers.includes('meta')) {
      window.webContents.sendInputEvent({ type: 'char', keyCode: '\r', modifiers });
    }
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    await pause(50);
  };
  const type = async (selector, text) => {
    await focus(selector); await key('A', ['control']);
    await window.webContents.insertText(text); await pause(60);
  };
  const completeChat = async () => {
    const job = calls.chat.at(-1);
    main.remote._emit({ kind: 'chat', jobId: job.jobId, conversationId: job.conversationId, type: 'event', event: { type: 'result', result: '模拟回复已完成。', session_id: `fixture-session-${calls.chat.length}`, is_error: false } });
    main.remote._emit({ kind: 'chat', jobId: job.jobId, conversationId: job.conversationId, type: 'exit', code: 0 });
    await until(() => exists('[aria-label="发送消息"]'), 'chat completed');
  };
  const completeTerminal = async () => {
    const job = calls.commands.at(-1);
    main.remote._emit({ kind: 'terminal', jobId: job.jobId, type: 'exit', code: 0 });
    await until(() => exists('[aria-label="运行命令输入"]'), 'terminal completed');
  };
  const selectedText = menu => evaluate(`document.querySelector(${JSON.stringify(`${menu} [aria-selected="true"]`)})?.textContent || ''`);
  const imeEnter = async selector => {
    // Chromium's sendInputEvent has no IME composition flag; dispatch the native
    // DOM composition sequence while all non-IME keys use sendInputEvent above.
    return evaluate(`(() => { const e=document.querySelector(${JSON.stringify(selector)}); e.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:''})); const event=new KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:229,isComposing:true,bubbles:true,cancelable:true}); const accepted=e.dispatchEvent(event); e.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:''})); return {accepted,prevented:event.defaultPrevented,value:e.value}; })()`);
  };
  const check = async (name, action) => { await action(); checks.push(name); console.log(`PASS ${name}`); };

  try {
    await until(() => evaluate('document.querySelector(".connection-button")?.textContent === "已连接"'), 'automatic fixture connection');
    await check('new settings enable shell commands by default and Ctrl+Enter sends once', async () => {
      assert.ok(await evaluate('document.querySelector(".permission-button")?.textContent.includes("可运行命令")'));
      await type(chatInput, '检查模拟项目。'); await key('Return', ['control']);
      await until(() => calls.chat.length === 1, 'default chat');
      assert.equal(calls.chat[0].allowCommands, true);
      assert.equal(calls.chat[0].mode, 'edit');
      assert.equal(calls.chat[0].prompt, '检查模拟项目。');
      await completeChat();
    });

    await check('slash suggestions support arrow navigation and Tab completion without sending', async () => {
      const before = calls.chat.length;
      await type(chatInput, '/'); await until(() => exists(chatMenu), 'slash command menu');
      const first = await selectedText(chatMenu);
      assert.ok(first.includes('/help'));
      await key('Down'); const second = await selectedText(chatMenu);
      assert.notEqual(second, first);
      await key('Up'); assert.equal(await selectedText(chatMenu), first);
      await key('Tab');
      assert.equal((await value(chatInput)).trim(), '/help');
      assert.equal(calls.chat.length, before);
      assert.equal(await exists(chatMenu), false);
    });

    await check('Enter accepts a slash candidate; Ctrl+Enter explicitly sends the command', async () => {
      const before = calls.chat.length;
      await type(chatInput, '/cont'); await until(() => exists(chatMenu), 'context completion');
      await key('Return');
      assert.equal((await value(chatInput)).trim(), '/context');
      assert.equal(calls.chat.length, before);
      await key('Return', ['control']); await until(() => calls.chat.length === before + 1, 'explicit context send');
      assert.equal(calls.chat.at(-1).prompt.trim(), '/context');
      await completeChat();
    });

    await check('Escape dismisses slash suggestions and IME Enter neither completes nor sends', async () => {
      const before = calls.chat.length;
      await type(chatInput, '/per'); await until(() => exists(chatMenu), 'permission completion');
      const composition = await imeEnter(chatInput);
      assert.equal(composition.accepted, true); assert.equal(composition.prevented, false);
      assert.equal(composition.value, '/per'); assert.equal(calls.chat.length, before);
      assert.equal(await exists('.modal'), false);
      await type(chatInput, '/per'); await key('Escape');
      assert.equal(await exists(chatMenu), false);
      assert.equal(await value(chatInput), '/per');
    });

    await check('local clear starts a new conversation while retaining existing history', async () => {
      const before = await main.store.load(); const chatCount = calls.chat.length;
      await type(chatInput, '/clear'); await key('Return', ['control']);
      await until(async () => (await main.store.load()).conversations.length === before.conversations.length + 1, 'local new conversation saved');
      const after = await main.store.load();
      assert.ok(after.conversations.find(c => c.id === 'fixture-conversation').messages.some(message => message.content === '这段已有历史不能被清除。'));
      assert.equal(calls.chat.length, chatCount);
      assert.equal(await value(chatInput), '');
    });

    await check('local permissions opens settings and disabled shell permission survives reload', async () => {
      const before = calls.chat.length;
      await type(chatInput, '/permissions'); await key('Return', ['control']);
      await until(() => exists('[role="dialog"][aria-label="工作台权限设置"]'), 'local permissions dialog');
      assert.equal(calls.chat.length, before);
      await click('.modal input[type="checkbox"]'); await clickText('完成');
      await until(async () => (await main.store.load()).settings.allowCommands === false, 'disabled shell preference persisted');
      await main.store.queue;
      await window.loadFile(path.resolve(__dirname, '..', 'dist', 'index.html'));
      await until(() => evaluate('document.querySelector(".connection-button")?.textContent === "已连接"'), 'reloaded auto connection');
      assert.ok(await evaluate('document.querySelector(".permission-button")?.textContent.includes("命令需手动运行")'));
      await type(chatInput, '只编辑文件。'); await key('Return', ['control']);
      await until(() => calls.chat.length === before + 1, 'chat after permission reload');
      assert.equal(calls.chat.at(-1).allowCommands, false);
      await completeChat();
    });

    await check('plan mode disables shell even when the saved command setting is enabled', async () => {
      await click('.permission-button'); await click('.modal input[type="checkbox"]'); await clickText('完成');
      await evaluate(`(() => { const e=document.querySelector('select[aria-label="Claude 工作模式"]'); e.value='plan'; e.dispatchEvent(new Event('change',{bubbles:true})); })()`);
      const before = calls.chat.length;
      await type(chatInput, '仅分析模拟项目。'); await key('Return', ['control']);
      await until(() => calls.chat.length === before + 1, 'plan mode chat');
      assert.equal(calls.chat.at(-1).mode, 'plan'); assert.equal(calls.chat.at(-1).allowCommands, false);
      await completeChat();
    });

    await check('terminal Tab and Enter complete candidates without running; a second Enter executes', async () => {
      await click('.terminal-heading > button');
      await type(shellInput, 'py'); await until(() => exists(shellMenu), 'terminal command menu');
      await key('Tab');
      const completed = await value(shellInput);
      assert.ok(completed.startsWith('python3'));
      assert.equal(calls.commands.length, 0); assert.equal(await exists(shellMenu), false);
      await type(shellInput, 'py'); await until(() => exists(shellMenu), 'terminal Enter completion');
      await key('Return'); assert.ok((await value(shellInput)).startsWith('python3'));
      assert.equal(calls.commands.length, 0);
      const command = await value(shellInput);
      await key('Return'); await until(() => calls.commands.length === 1, 'explicit terminal execution');
      assert.equal(calls.commands[0].command, command);
    });

    await check('running terminal accepts raw input without completion and preserves IME Enter', async () => {
      await type(shellInput, 'py');
      assert.equal(await exists(shellMenu), false);
      const composition = await imeEnter(shellInput);
      assert.equal(composition.accepted, true); assert.equal(composition.prevented, false);
      assert.equal(composition.value, 'py'); assert.equal(calls.writes.length, 0);
      await key('Return'); await until(() => calls.writes.length === 1, 'program stdin');
      assert.equal(calls.writes[0].data, 'py\n');
      assert.equal(calls.commands.length, 1);
      await completeTerminal();
    });

    await check('Escape dismisses terminal completion without changing the input or running it', async () => {
      await type(shellInput, 'py'); await until(() => exists(shellMenu), 'terminal completion before Escape');
      await key('Escape');
      assert.equal(await exists(shellMenu), false); assert.equal(await value(shellInput), 'py');
      assert.equal(calls.commands.length, 1);
    });

    await type(chatInput, '/'); await until(() => exists(chatMenu), 'screenshot command menu');
    await evaluate(`(() => { const note=document.createElement('div'); note.id='fixture-banner'; note.textContent='命令补全测试 · 模拟 远程设备 / Claude，未连接真实设备'; note.style.cssText='position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:9999;background:#fff2dc;border:1px solid #bc9a62;color:#815d2b;padding:5px 12px;border-radius:5px;font:11px sans-serif;'; document.body.append(note); })()`);
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'); await pause(120);
    const outputDirectory = path.resolve(__dirname, '..', 'output');
    await fs.mkdir(outputDirectory, { recursive: true });
    await fs.writeFile(path.join(outputDirectory, 'commands-fixture.png'), (await window.webContents.capturePage()).toPNG());
    const minimumLayout = {};
    await check('chat and terminal command menus remain within the minimum window viewport', async () => {
      window.setSize(1040, 700); await pause(180);
      const geometry = selector => evaluate(`(() => { const menu=document.querySelector(${JSON.stringify(selector)}).closest('.command-menu'); const r=menu.getBoundingClientRect(); const hit=document.elementFromPoint(r.left+20,r.top+20); return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:innerWidth,height:innerHeight,documentWidth:document.documentElement.scrollWidth,visibleAtHeading:menu.contains(hit)}; })()`);
      minimumLayout.chat = await geometry(chatMenu);
      for (const rectangle of [minimumLayout.chat]) {
        assert.ok(rectangle.left >= -1 && rectangle.top >= -1 && rectangle.right <= rectangle.width + 1 && rectangle.bottom <= rectangle.height + 1, JSON.stringify(rectangle));
        assert.ok(rectangle.documentWidth <= rectangle.width + 1, 'horizontal page overflow at minimum size');
        assert.ok(rectangle.visibleAtHeading, 'chat suggestions are clipped or covered');
      }
      await type(shellInput, 'p'); await type(shellInput, 'py');
      await until(() => exists(shellMenu), 'minimum window terminal completion');
      minimumLayout.terminal = await geometry(shellMenu);
      const rectangle = minimumLayout.terminal;
      assert.ok(rectangle.left >= -1 && rectangle.top >= -1 && rectangle.right <= rectangle.width + 1 && rectangle.bottom <= rectangle.height + 1, JSON.stringify(rectangle));
      assert.ok(rectangle.documentWidth <= rectangle.width + 1, 'terminal page overflow at minimum size');
      assert.ok(rectangle.visibleAtHeading, 'terminal suggestions are clipped or covered');
      await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'); await pause(120);
      await fs.writeFile(path.join(outputDirectory, 'commands-minimum-fixture.png'), (await window.webContents.capturePage()).toPNG());
    });
    await main.store.queue;
    const report = { passed: checks.length, checks, minimumLayout, realSSH: false, realClaude: false, actualElectronIPC: true, actualChromiumKeyboard: true, imeEvents: 'DOM composition events; no physical IME used', testDataDirectory: temporaryRoot };
    await fs.writeFile(path.join(outputDirectory, 'commands-flow.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } finally { await main.store.queue; console.log(`TEST_DATA_DIRECTORY ${temporaryRoot}`); }
}

run().then(() => app.exit(0), error => { console.error(error.stack || error); app.exit(1); });
