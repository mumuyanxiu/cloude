'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const { createWorkspaceRestarter } = require('../electron/workspace-restart.cjs');

const checks = [];
let relaunches = 0;
app.relaunch = () => { relaunches++; };

async function run() {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'cloude-restart-flow-'));
  app.setPath('userData', profile);
  await app.whenReady();
  const window = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
  await window.loadURL('data:text/html,<p>Cloude restart fixture</p>');
  const restart = createWorkspaceRestarter({ app, getWindows: () => [window] });
  window.once('close', event => event.preventDefault());
  assert.equal(await restart(['--legacy']), false);
  assert.equal(window.isDestroyed(), false);
  assert.equal(relaunches, 0);
  checks.push('canceling a native close keeps the original window');

  await window.webContents.executeJavaScript('window.onbeforeunload = () => false; void 0;');
  assert.equal(await restart(['--legacy']), false);
  assert.equal(window.isDestroyed(), false);
  assert.equal(relaunches, 0);
  checks.push('canceling beforeunload preserves the window and clears the restart');
  await window.webContents.executeJavaScript('window.onbeforeunload = null; void 0;');

  const reportDirectory = path.resolve(__dirname, '..', 'output');
  await fs.mkdir(reportDirectory, { recursive: true });
  app.once('quit', () => {
    try {
      assert.equal(relaunches, 0);
      checks.push('a later ordinary application quit does not relaunch');
      require('node:fs').writeFileSync(path.join(reportDirectory, 'workspace-restart-flow.json'), JSON.stringify({ passed: checks.length, checks }, null, 2));
      console.log(JSON.stringify({ passed: checks.length, checks }));
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
    }
  });
  app.quit();
}

run().catch(error => { console.error(error); app.exit(1); });
