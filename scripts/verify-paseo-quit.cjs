'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const ts = require('typescript');

async function verifyPaseoQuit(source) {
  let windows = [];
  const settle = () => new Promise(resolve => setImmediate(resolve));
  function load(relativePath, imports = {}, extra = '') {
    const filename = path.join(source, relativePath);
    const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }, fileName: filename,
    });
    const result = {};
    vm.runInNewContext(compiled.outputText + extra, {
      exports: result, Promise, AbortSignal, Error,
      require(name) { assert.ok(name in imports, `Unexpected import ${name}`); return imports[name]; },
    }, { filename });
    return result;
  }
  const guard = load('packages/desktop/src/cloude-quit.ts', { electron: { BrowserWindow: { getAllWindows: () => windows } } });
  function windowFixture(accepted) {
    const window = new EventEmitter();
    window.webContents = new EventEmitter();
    let destroyed = false;
    window.isDestroyed = () => destroyed;
    window.close = () => {
      window.emit('close', { defaultPrevented: false });
      if (!accepted) { window.webContents.emit('will-prevent-unload', { defaultPrevented: false }); return; }
      destroyed = true;
      window.emit('closed');
      assert.equal(guard.isCloudeWindowCloseInProgress(), true);
    };
    return window;
  }
  const { createQuitLifecycle } = load('packages/desktop/src/daemon/quit-lifecycle.ts');
  let exits = 0;
  let disconnects = 0;
  let stops = 0;
  let finishStop;
  const lifecycle = createQuitLifecycle({
    app: { exit() { exits++; } },
    closeTransportSessions() { disconnects++; },
    prepareQuit: guard.closeCloudeWindowsForQuit,
    stopDesktopManagedDaemonIfNeeded: () => { stops++; return new Promise(resolve => { finishStop = resolve; }); },
    installAppUpdateOnQuit: async () => false,
    createUpdateDeadlineSignal: () => new AbortController().signal,
    onStopError: assert.fail, onUpdateError: assert.fail,
  });
  const event = () => ({ defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } });
  windows = [windowFixture(false)];
  lifecycle.handleBeforeQuit(event());
  await settle();
  assert.deepEqual({ exits, disconnects, stops }, { exits: 0, disconnects: 0, stops: 0 });
  assert.equal(windows[0].isDestroyed(), false);

  windows = [windowFixture(true)];
  lifecycle.handleBeforeQuit(event());
  const repeated = event();
  lifecycle.handleBeforeQuit(repeated);
  assert.equal(repeated.defaultPrevented, true);
  await settle();
  assert.deepEqual({ exits, disconnects, stops }, { exits: 0, disconnects: 1, stops: 1 });
  finishStop(true);
  await settle();
  assert.deepEqual({ exits, disconnects, stops }, { exits: 1, disconnects: 1, stops: 1 });

  const service = load('packages/desktop/src/features/app-update-service.ts', {
    '../cloude-quit.js': guard,
    './app-update-rollout.js': {},
  }, '\nexports.testPerformQuitAndInstall = performQuitAndInstall;');
  const calls = [];
  const runtime = { quitAndInstall() { calls.push('installer'); } };
  const installOptions = { targetVersion: '2.0.0', restart: true, onBeforeQuit: async () => { calls.push('cleanup'); } };
  windows = [windowFixture(false)];
  await assert.rejects(service.testPerformQuitAndInstall(runtime, installOptions), /已取消安装/);
  assert.deepEqual(calls, []);
  windows = [windowFixture(true)];
  await service.testPerformQuitAndInstall(runtime, installOptions);
  assert.deepEqual(calls, ['cleanup', 'installer']);
  return { passed: 3, checks: ['canceled ordinary quit preserves transport and daemon', 'repeated quits wait for a single daemon cleanup', 'update installation waits for accepted window closure'] };
}

if (require.main === module) {
  verifyPaseoQuit(process.argv[2]).then(result => console.log(JSON.stringify(result)), error => { console.error(error); process.exitCode = 1; });
}

module.exports = { verifyPaseoQuit };
