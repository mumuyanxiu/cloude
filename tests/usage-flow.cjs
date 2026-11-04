'use strict';

// Runs the real Electron UI/preload/main IPC with fixture-only SSH and usage.
// This verifies account limits, not token consumption or a real paid account.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const temporaryRoot = require('node:fs').mkdtempSync(path.join(os.tmpdir(), 'workspace-usage-flow-'));
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
  const config = { host: 'fixture-usage-a', port: 22, username: 'fixture', authType: 'key', privateKeyPath: 'C:/fixture/key', workspace, claudePath: 'claude', autoConnect: true };
  await fs.writeFile(path.join(dataDirectory, 'workspace.json'), JSON.stringify({
    connection: config,
    projects: [{ id: 'fixture-project', name: 'usage-fixture', path: `${workspace}/usage-fixture`, connectionKey: `fixture@fixture-usage-a:22:${workspace}` }],
    conversations: [], settings: { activeProjectId: 'fixture-project' },
  }));
  const unexpected = () => { throw new Error('Unexpected native UI in usage fixture test'); };
  dialog.showOpenDialog = unexpected; dialog.showSaveDialog = unexpected;
  dialog.showMessageBox = unexpected; dialog.showMessageBoxSync = unexpected;
  shell.openExternal = unexpected; shell.showItemInFolder = unexpected;
  const calls = { connect: [], usage: 0 };
  const usage = (sessionPercent, weeklyPercent) => ({
    available: true, fetchedAt: Date.now(), limits: [
      { kind: 'session', group: 'all', percent: sessionPercent, resetsAt: '2099-11-02T15:45:00.000Z', label: '五小时用量' },
      { kind: 'weekly_all', group: 'all', percent: weeklyPercent, resetsAt: '2099-11-05T08:20:00.000Z', label: '每周总用量' },
    ],
  });
  let nextUsage = async () => usage(32, 68);
  let finishOldUsage;
  const main = require('../electron/main.cjs');
  main.remote.clientFactory = () => { throw new Error('Real SSH forbidden in usage-flow test'); };
  main.remote.connect = async value => { calls.connect.push(value); return { home: '/home/fixture', workspace, hostname: value.host, claudeAvailable: true, claudeVersion: 'fixture-only' }; };
  main.remote.disconnect = async () => {};
  main.remote.listFiles = async () => [];
  main.remote.getUsage = async () => { calls.usage++; return nextUsage(); };
  const window = await main.ready;
  window.webContents.setBackgroundThrottling(false);
  const evaluate = async code => { try { return await window.webContents.executeJavaScript(code); } catch (error) { throw new Error(`Renderer evaluation failed: ${code}\n${error.message}`); } };
  const click = selector => evaluate(`(() => { const e=document.querySelector(${JSON.stringify(selector)}); if(!e) throw new Error('Missing target '+${JSON.stringify(selector)}); if(e.disabled) throw new Error('Disabled target '+${JSON.stringify(selector)}); e.click(); })()`);
  const clickText = text => evaluate(`(() => { const e=[...document.querySelectorAll('.modal button')].find(e=>e.textContent.trim()===${JSON.stringify(text)}); if(!e) throw new Error('Missing button '+${JSON.stringify(text)}); if(e.disabled) throw new Error('Disabled button'); e.click(); })()`);
  const connected = () => evaluate('document.querySelector(".connection-button")?.textContent === "已连接"');
  const card = '[aria-label="Claude 账户额度"]';
  const cardText = () => evaluate(`document.querySelector(${JSON.stringify(card)})?.innerText || ''`);
  const refresh = () => click('[aria-label="刷新账户额度"]');
  const waitText = text => until(async () => (await cardText()).includes(text), `usage text ${text}`);
  const check = async (name, action) => { await action(); checks.push(name); console.log(`PASS ${name}`); };
  const waitIdle = () => until(() => evaluate(`!document.querySelector('[aria-label="刷新账户额度"]')?.disabled`), 'usage request complete');

  try {
    await check('connected account card shows five-hour and weekly percentages with reset times', async () => {
      await until(connected, 'startup connection');
      await waitText('32%'); await waitText('68%');
      const text = await cardText();
      assert.ok(text.includes('五小时用量')); assert.ok(text.includes('每周总用量'));
      assert.ok(text.includes('重置'));
      assert.ok(text.includes('11月2日') || text.includes('11/2') || text.includes('11-02') || text.includes('11月02日'), 'session reset date missing');
      assert.ok(text.includes('11月5日') || text.includes('11/5') || text.includes('11-05') || text.includes('11月05日'), 'weekly reset date missing');
      assert.equal(calls.usage, 1);
      await evaluate(`(() => { const note=document.createElement('div'); note.id='fixture-banner'; note.textContent='模拟设备与额度数据 · 未连接真实 远程设备 / Claude 账户'; note.style.cssText='position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:9999;background:#fff2dc;border:1px solid #bc9a62;color:#815d2b;padding:5px 12px;border-radius:5px;font:11px sans-serif;'; document.body.append(note); })()`);
      await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      await pause(120);
      const screenshotDirectory = path.resolve(__dirname, '..', 'output');
      await fs.mkdir(screenshotDirectory, { recursive: true });
      await fs.writeFile(path.join(screenshotDirectory, 'usage-panel-fixture.png'), (await window.webContents.capturePage()).toPNG());
      await evaluate('document.getElementById("fixture-banner").remove()');
    });

    await check('account card can be collapsed and expanded manually', async () => {
      await click('[aria-label="收起账户额度"]');
      await until(() => evaluate(`!!document.querySelector('[aria-label="展开账户额度"]')`), 'collapsed account card');
      assert.ok(!(await cardText()).includes('32%'));
      await click('[aria-label="展开账户额度"]');
      await waitText('32%'); await waitIdle();
    });

    await check('failed refresh marks previous usage as stale instead of replacing with zero', async () => {
      nextUsage = async () => { throw new Error('模拟额度查询失败'); };
      await refresh(); await waitText('刷新失败');
      const text = await cardText();
      assert.ok(text.includes('32%')); assert.ok(text.includes('68%'));
      assert.ok(!text.includes('0%'));
    });

    await check('missing limits show unavailable rather than fabricated zero usage', async () => {
      nextUsage = async () => ({ available: false, fetchedAt: Date.now(), limits: [], message: '模拟账户未提供额度数据' });
      await refresh(); await waitText('模拟账户未提供额度数据');
      const text = await cardText();
      assert.ok(!text.includes('0%'));
      assert.ok(text.includes('刷新失败'), 'previous values must be identified as stale');
    });

    await check('a genuine zero-percent account limit remains valid data', async () => {
      nextUsage = async () => usage(0, 12);
      await refresh(); await waitText('0%'); await waitText('12%');
      assert.ok(!(await cardText()).includes('模拟账户未提供额度数据'));
    });

    await check('disconnect clears usage and ignores an old connection response', async () => {
      nextUsage = () => new Promise(resolve => { finishOldUsage = resolve; });
      await refresh(); await until(() => !!finishOldUsage, 'pending old usage query');
      await click('.connection-button'); await clickText('断开连接');
      await waitText('连接后查看额度');
      assert.ok(!(await cardText()).includes('12%'));
      await pause(250);
      assert.ok(!(await cardText()).includes('97%')); assert.ok(!(await cardText()).includes('99%'));
      assert.equal(await connected(), false);
    });

    await check('a different connection displays only its fresh account usage', async () => {
      nextUsage = async () => usage(7, 14);
      await click('.connection-button');
      await evaluate(`(() => { const e=[...document.querySelectorAll('.modal label')].find(e=>e.textContent.startsWith('主机名或 IP 地址')).querySelector('input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'fixture-usage-b'); e.dispatchEvent(new Event('input',{bubbles:true})); })()`);
      await pause(40); await clickText('连接设备');
      await until(connected, 'device B connected');
      // Device B must connect without waiting for device A's account query.
      // Its late result must never populate B's card, even transiently.
      assert.ok(!(await cardText()).includes('97%'));
      finishOldUsage(usage(97, 99));
      await waitText('7%'); await waitText('14%');
      assert.equal(calls.connect.at(-1).host, 'fixture-usage-b');
      const text = await cardText();
      assert.ok(!text.includes('97%')); assert.ok(!text.includes('99%')); assert.ok(!text.includes('12%'));
    });

    await check('first unavailable response has no zero-percent meter or previous-device data', async () => {
      nextUsage = async () => ({ available: false, fetchedAt: Date.now(), limits: [], message: '模拟新设备没有额度记录' });
      main.remote._emit({ kind: 'connection', status: 'disconnected', message: '模拟设备 B 断线' });
      await waitText('连接后查看额度');
      await click('.connection-button');
      await evaluate(`(() => { const e=[...document.querySelectorAll('.modal label')].find(e=>e.textContent.startsWith('主机名或 IP 地址')).querySelector('input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'fixture-usage-c'); e.dispatchEvent(new Event('input',{bubbles:true})); })()`);
      await pause(40); await clickText('连接设备');
      await waitText('模拟新设备没有额度记录');
      const text = await cardText();
      assert.ok(!text.includes('0%')); assert.ok(!text.includes('7%')); assert.ok(!text.includes('14%'));
      assert.equal(await evaluate(`document.querySelectorAll('${card} [role="meter"]').length`), 0);
    });

    await main.store.queue;
    const outputDirectory = path.resolve(__dirname, '..', 'output');
    await fs.mkdir(outputDirectory, { recursive: true });
    const report = { passed: checks.length, checks, realSSH: false, realAccountUsage: false, actualElectronIPC: true, testDataDirectory: temporaryRoot };
    await fs.writeFile(path.join(outputDirectory, 'usage-flow.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } finally {
    await main.store.queue;
    console.log(`TEST_DATA_DIRECTORY ${temporaryRoot}`);
  }
}

run().then(() => app.exit(0), error => { console.error(error.stack || error); app.exit(1); });
