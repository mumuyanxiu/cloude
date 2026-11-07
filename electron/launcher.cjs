'use strict';

const path = require('node:path');
const { app, BrowserWindow, Menu, MenuItem, dialog, shell } = require('electron');
const {
  configureProfile, configurePaseoEnvironment, loadDefaultMode, resolveMode,
  relaunchArgs, saveDefaultMode,
} = require('./workspace-startup.cjs');

const dataDirectory = configureProfile(app);
const restartWorkspace = require('./workspace-restart.cjs').createWorkspaceRestarter({ app, getWindows: () => BrowserWindow.getAllWindows() });
let legacy;
let defaultMode;
let mode;

function showError(error) {
  dialog.showErrorBox('Cloude', error.message || String(error));
}

function switchWorkspace(target) {
  if (target === mode) return;
  const args = relaunchArgs(process.argv, target);
  installMenu(Menu.getApplicationMenu());
  if (legacy) {
    legacy.restartWorkspace(args).catch(showError);
    return;
  }
  void restartWorkspace(args).catch(showError);
}

function workspaceMenu() {
  return new MenuItem({
    id: 'cloude-workspace-menu', label: 'Cloude', submenu: [
      { id: 'cloude-mode-paseo', label: '2.0 多智能体工作台（重启切换）', type: 'radio', checked: mode === 'paseo', click: () => switchWorkspace('paseo') },
      { id: 'cloude-mode-legacy', label: 'SSH 兼容工作台（重启切换）', type: 'radio', checked: mode === 'legacy', click: () => switchWorkspace('legacy') },
      { type: 'separator' },
      { id: 'cloude-default-workspace', label: '将当前工作台设为启动默认值', enabled: mode !== defaultMode, click: async () => {
        try {
          await saveDefaultMode(dataDirectory, mode);
          defaultMode = mode;
          installMenu(Menu.getApplicationMenu());
        } catch (error) { showError(error); }
      } },
      { label: '打开 Cloude 数据目录', click: () => { void shell.openPath(dataDirectory).then(error => { if (error) showError(new Error(error)); }).catch(showError); } },
      { label: '查看 Cloude 发布', click: () => { void shell.openExternal('https://github.com/mumuyanxiu/cloude/releases/latest').catch(showError); } },
    ],
  });
}

const setApplicationMenu = Menu.setApplicationMenu.bind(Menu);
function installMenu(menu) {
  const next = menu || new Menu();
  if (next.getMenuItemById('cloude-workspace-menu')) {
    next.getMenuItemById('cloude-mode-paseo').checked = mode === 'paseo';
    next.getMenuItemById('cloude-mode-legacy').checked = mode === 'legacy';
    next.getMenuItemById('cloude-default-workspace').enabled = mode !== defaultMode;
  } else {
    next.insert(0, workspaceMenu());
  }
  setApplicationMenu(next);
}

function start() {
  mode = resolveMode(process.argv, null);
  try { defaultMode = loadDefaultMode(dataDirectory); }
  catch (error) { if (!mode) throw error; }
  mode = mode || defaultMode;
  // Paseo rebuilds its menu when shortcut capture changes. Keep the Cloude
  // workspace entry present across those rebuilds without changing its IPC API.
  Menu.setApplicationMenu = installMenu;
  if (mode === 'legacy') {
    legacy = require('./main.cjs');
    legacy.ready.then(() => installMenu(Menu.getApplicationMenu())).catch(showError);
    return legacy;
  }
  configurePaseoEnvironment(dataDirectory);
  // These flags select the Cloude entry. Paseo otherwise interprets unknown
  // command-line flags as requests to run its CLI instead of opening the GUI.
  process.argv = process.argv.filter(argument => argument !== '--paseo' && argument !== '--legacy');
  app.on('browser-window-created', (_event, window) => {
    window.webContents.on('will-prevent-unload', event => {
      if (!window.webContents.getURL().startsWith('paseo://app')) return;
      const choice = dialog.showMessageBoxSync(window, {
        type: 'question', title: '尚有未保存的修改',
        message: '编辑器仍有未保存、保存中或冲突的修改。',
        detail: '返回编辑后可等待自动保存完成，或处理保存错误和文件冲突。',
        buttons: ['返回编辑', '放弃修改并关闭'], defaultId: 0, cancelId: 0,
      });
      if (choice === 1) event.preventDefault();
    });
  });
  const runtimeDirectory = app.isPackaged
    ? path.join(process.resourcesPath, 'paseo')
    : path.join(__dirname, '..', 'runtime', 'paseo');
  require(path.join(runtimeDirectory, 'desktop-dist', 'main.js'));
  return null;
}

try { start(); }
catch (error) {
  console.error('Cloude workspace startup failed', error.stack || error);
  void app.whenReady().then(async () => {
    const choice = await dialog.showMessageBox({
      type: 'error', title: 'Cloude 启动失败', message: '工作台启动失败。',
      detail: error.message || String(error),
      buttons: ['关闭', '打开 SSH 兼容工作台'], defaultId: 0, cancelId: 0,
    });
    if (choice.response === 1) app.relaunch({ args: relaunchArgs(process.argv, 'legacy') });
    app.exit(choice.response === 1 ? 0 : 1);
  });
}

module.exports = { get mode() { return mode; }, dataDirectory, switchWorkspace, getWindows: () => BrowserWindow.getAllWindows() };
