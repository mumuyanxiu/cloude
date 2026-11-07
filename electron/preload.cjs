const { contextBridge, ipcRenderer, webUtils } = require('electron');
const names = ['loadState', 'saveState', 'pickPrivateKey', 'connect', 'disconnect', 'openProject', 'listSessions', 'readSession', 'listFiles', 'readFile', 'saveFile', 'mkdir', 'download', 'upload', 'startChat', 'runCommand', 'writeJob', 'stopJob', 'getDiff', 'getUsage', 'getModels', 'showInFolder', 'openExternal', 'getUpdateState', 'checkForUpdates', 'downloadUpdate', 'installUpdate', 'openReleases'];
const api = Object.fromEntries(names.map(name => [name, value => ipcRenderer.invoke(`workspace:${name}`, value)]));
for (const name of ['stageClipboard', 'discardAttachments', 'uploadAttachments', 'readMedia', 'copyImage', 'copyText', 'searchFiles', 'openTerminal', 'resizeTerminal', 'forwardPort', 'listPorts', 'closePort', 'startPersistentChat', 'listTasks', 'pollTask', 'replyTask', 'stopTask', 'notifyTask', 'openLocalFile', 'downloadBundle']) api[name] = value => ipcRenderer.invoke(`workspace:${name}`, value);
api.stageDropped = async files => {
  if (!Array.isArray(files) || files.length > 32) throw new Error('一次最多添加 32 个附件');
  const items = [];
  for (const file of files) {
    const localPath = webUtils.getPathForFile(file);
    if (localPath) items.push({ path: localPath });
    else {
      if (file.size > 20 * 1024 * 1024 || !/^image\/(png|jpeg|gif|webp)$/.test(file.type)) throw new Error('粘贴的图片无效或过大');
      items.push({ bytes: new Uint8Array(await file.arrayBuffer()), mime: file.type });
    }
  }
  return ipcRenderer.invoke('workspace:stageDropped', items);
};
api.onEvent = callback => {
  if (typeof callback !== 'function') throw new TypeError('事件回调必须是函数');
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on('workspace:event', listener);
  return () => { ipcRenderer.removeListener('workspace:event', listener); };
};
contextBridge.exposeInMainWorld('workspace', Object.freeze(api));
