'use strict';

function createWorkspaceRestarter({ app, getWindows }) {
  let pending = null;

  return function restartWorkspace(args) {
    if (pending) return pending.promise;
    let resolve;
    const promise = new Promise(complete => { resolve = complete; });
    const request = { promise };
    pending = request;
    const windows = getWindows().filter(window => !window.isDestroyed());
    const listeners = [];
    let remaining = windows.length;

    function listen(emitter, event, callback) {
      emitter.on(event, callback);
      listeners.push(() => emitter.removeListener(event, callback));
    }

    function finish(restarted) {
      for (const remove of listeners) remove();
      if (pending === request) pending = null;
      resolve(restarted);
    }

    function cancel() { finish(false); }

    function quitAfterWindowsClose() {
      let quitRequested = false;
      // Paseo ends its asynchronous daemon cleanup with app.exit(), which emits
      // quit but skips will-quit. Arm relaunch at the actual accepted exit.
      listen(app, 'quit', () => {
        app.relaunch({ args });
        finish(true);
      });
      listen(app, 'will-quit', event => { if (event.defaultPrevented) cancel(); });
      listen(app, 'browser-window-created', cancel);
      listen(app, 'before-quit', () => { quitRequested = true; });
      // window-all-closed may request quit after the final closed event. Do not
      // send a second quit through Paseo's asynchronous daemon cleanup.
      const timer = setImmediate(() => {
        if (pending === request && !quitRequested) app.quit();
      });
      listeners.push(() => clearImmediate(timer));
    }

    for (const window of windows) {
      listen(window, 'close', event => { if (event.defaultPrevented) cancel(); });
      listen(window.webContents, 'will-prevent-unload', event => {
        if (!event.defaultPrevented) cancel();
      });
      listen(window, 'closed', () => {
        remaining--;
        if (!remaining && pending === request) quitAfterWindowsClose();
      });
    }
    if (!remaining) quitAfterWindowsClose();
    for (const window of windows) {
      if (pending !== request) break;
      if (!window.isDestroyed()) window.close();
    }
    return promise;
  };
}

module.exports = { createWorkspaceRestarter };
