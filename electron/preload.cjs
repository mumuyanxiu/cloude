const { contextBridge, ipcRenderer } = require('electron');
const names = ['loadState', 'saveState', 'pickPrivateKey', 'connect', 'disconnect', 'openProject', 'listSessions', 'readSession', 'listFiles', 'readFile', 'saveFile', 'mkdir', 'download', 'upload', 'startChat', 'runCommand', 'writeJob', 'stopJob', 'getDiff', 'getUsage', 'showInFolder', 'openExternal', 'getUpdateState', 'checkForUpdates', 'downloadUpdate', 'installUpdate', 'openReleases'];
const api = Object.fromEntries(names.map(name => [name, value => ipcRenderer.invoke(`workspace:${name}`, value)]));
api.onEvent = callback => {
  if (typeof callback !== 'function') throw new TypeError('事件回调必须是函数');
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on('workspace:event', listener);
  return () => { ipcRenderer.removeListener('workspace:event', listener); };
};
contextBridge.exposeInMainWorld('workspace', Object.freeze(api));
