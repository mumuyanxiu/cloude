import { BrowserWindow } from "electron";

let pendingClose: Promise<boolean> | null = null;

export function isCloudeWindowCloseInProgress(): boolean {
  return pendingClose !== null;
}

export function closeCloudeWindowsForQuit(): Promise<boolean> {
  if (pendingClose) return pendingClose;
  const windows = BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed());
  if (!windows.length) return Promise.resolve(true);
  let complete!: (accepted: boolean) => void;
  const result = new Promise<boolean>((resolve) => { complete = resolve; });
  const listeners: (() => void)[] = [];
  let remaining = windows.length;
  let finished = false;
  pendingClose = result.finally(() => { pendingClose = null; });

  function finish(accepted: boolean): void {
    if (finished) return;
    finished = true;
    for (const remove of listeners) remove();
    complete(accepted);
  }

  for (const window of windows) {
    const contents = window.webContents;
    const onClose = (event: Electron.Event): void => {
      if (event.defaultPrevented) finish(false);
    };
    const onPreventUnload = (event: Electron.Event): void => {
      if (!event.defaultPrevented) finish(false);
    };
    const onClosed = (): void => {
      remaining--;
      if (!remaining) finish(true);
    };
    window.on("close", onClose);
    contents.on("will-prevent-unload", onPreventUnload);
    window.on("closed", onClosed);
    listeners.push(() => {
      window.removeListener("close", onClose);
      contents.removeListener("will-prevent-unload", onPreventUnload);
      window.removeListener("closed", onClosed);
    });
  }
  for (const window of windows) {
    if (finished) break;
    try { window.close(); }
    catch { finish(false); }
  }
  return pendingClose;
}
