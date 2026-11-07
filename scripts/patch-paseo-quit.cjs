'use strict';

const fs = require('node:fs');
const path = require('node:path');

function patchPaseoQuit(source, replace) {
  fs.copyFileSync(path.join(__dirname, 'paseo-cloude-quit.ts'), path.join(source, 'packages/desktop/src/cloude-quit.ts'));
  replace(source, 'packages/desktop/src/main.ts',
    'import { installAppUpdateOnQuit } from "./features/auto-updater.js";\nimport {',
    'import { installAppUpdateOnQuit } from "./features/auto-updater.js";\nimport { closeCloudeWindowsForQuit, isCloudeWindowCloseInProgress } from "./cloude-quit.js";\nimport {');
  replace(source, 'packages/desktop/src/main.ts',
    '  closeTransportSessions: closeAllTransportSessions,\n  stopDesktopManagedDaemonIfNeeded:',
    '  closeTransportSessions: closeAllTransportSessions,\n  prepareQuit: closeCloudeWindowsForQuit,\n  stopDesktopManagedDaemonIfNeeded:');
  replace(source, 'packages/desktop/src/main.ts',
    '  if (process.platform !== "darwin") {\n    app.quit();\n  }\n});',
    '  if (process.platform !== "darwin" && !isCloudeWindowCloseInProgress()) {\n    app.quit();\n  }\n});');
  const lifecycle = 'packages/desktop/src/daemon/quit-lifecycle.ts';
  replace(source, lifecycle,
    '  closeTransportSessions,\n  stopDesktopManagedDaemonIfNeeded,',
    '  closeTransportSessions,\n  prepareQuit,\n  stopDesktopManagedDaemonIfNeeded,');
  replace(source, lifecycle,
    '  closeTransportSessions: () => void;\n  stopDesktopManagedDaemonIfNeeded:',
    '  closeTransportSessions: () => void;\n  prepareQuit?: () => Promise<boolean>;\n  stopDesktopManagedDaemonIfNeeded:');
  replace(source, lifecycle,
    '    closeTransportSessions();\n    if (quittingForUpdate) return;',
    '    if (!prepareQuit) closeTransportSessions();\n    if (quittingForUpdate) return;');
  replace(source, lifecycle,
    '    if (quitting) {\n      // MacUpdater',
    '    if (quitting) {\n      if (prepareQuit) { event.preventDefault(); return; }\n      // MacUpdater');
  replace(source, lifecycle,
    '    void (async () => {\n      try {\n        await stopDesktopManagedDaemonIfNeeded();',
    '    void (async () => {\n      if (prepareQuit) {\n        if (!await prepareQuit()) { quitting = false; return; }\n        closeTransportSessions();\n      }\n      try {\n        await stopDesktopManagedDaemonIfNeeded();');
  const updates = 'packages/desktop/src/features/app-update-service.ts';
  const updateFile = path.join(source, updates);
  const updateSource = fs.readFileSync(updateFile, 'utf8');
  const importLine = 'import { closeCloudeWindowsForQuit } from "../cloude-quit.js";\n';
  if (!updateSource.includes(importLine)) fs.writeFileSync(updateFile, importLine + updateSource);
  // Replace the earlier local build's one-line guard when reusing its cache.
  const earlierGuard = '  if (!await closeCloudeWindowsForQuit()) throw new Error("已取消安装，编辑器修改已保留。");\n';
  const currentSource = fs.readFileSync(updateFile, 'utf8');
  if (currentSource.includes(earlierGuard)) fs.writeFileSync(updateFile, currentSource.replaceAll(earlierGuard, ''));
  replace(source, updates,
    '  if (onBeforeQuit) await onBeforeQuit();\n  runtime.quitAndInstall({',
    '  if (!await closeCloudeWindowsForQuit()) {\n    throw new Error("已取消安装，编辑器修改已保留。");\n  }\n  if (onBeforeQuit) {\n    await onBeforeQuit();\n  }\n  runtime.quitAndInstall({');
}

module.exports = { patchPaseoQuit };
