'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

async function verifyPaseoEditorClose(source) {
  const filename = path.join(source, 'packages/app/src/file-panels/source/editor/model.ts');
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    fileName: filename,
  });
  const window = new EventTarget();
  const modelModule = { exports: {} };
  class PluginFileConflictError extends Error {}
  class PluginFileDeletedError extends Error {}
  vm.runInNewContext(compiled.outputText, {
    exports: modelModule.exports, window, globalThis, Error,
    require(name) {
      assert.equal(name, '@getpaseo/plugin/client');
      return { PluginFileConflictError, PluginFileDeletedError };
    },
  }, { filename });
  const { FileEditorModel, hasUnsavedSourceEdits } = modelModule.exports;
  const settle = () => new Promise(resolve => setImmediate(resolve));
  const clock = { setTimeout: () => 1, clearTimeout: () => {} };
  const checkClose = () => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  };
  async function editor(write = async () => {}) {
    const file = { readText: async () => 'original', writeText: write, watch: () => () => {} };
    const model = new FileEditorModel({ file, clock });
    model.open();
    await settle();
    return model;
  }

  const first = await editor();
  const second = await editor();
  assert.equal(checkClose(), false);
  first.edit('first draft');
  second.edit('second draft');
  assert.equal(checkClose(), true);
  assert.equal(first.getSnapshot().content, 'first draft');
  assert.equal(second.getSnapshot().content, 'second draft');
  await first.save();
  assert.equal(hasUnsavedSourceEdits(), true);
  await second.save();
  assert.equal(checkClose(), false);
  first.dispose({ flush: false });
  second.dispose({ flush: false });

  let completeWrite;
  const saving = await editor(() => new Promise(resolve => { completeWrite = resolve; }));
  saving.edit('pending save');
  const save = saving.save();
  assert.equal(saving.getSnapshot().status, 'saving');
  assert.equal(checkClose(), true);
  completeWrite();
  await save;
  assert.equal(checkClose(), false);
  saving.dispose({ flush: false });

  const failed = await editor(async () => { throw new Error('offline fixture'); });
  failed.edit('draft retained after save error');
  await failed.save();
  assert.equal(failed.getSnapshot().status, 'error');
  assert.equal(checkClose(), true);
  assert.equal(failed.getSnapshot().content, 'draft retained after save error');
  failed.dispose({ flush: false });

  const disposed = await editor(() => new Promise(resolve => { completeWrite = resolve; }));
  disposed.edit('flush before leaving panel');
  disposed.dispose({ flush: true });
  assert.equal(checkClose(), true);
  completeWrite();
  await settle();
  assert.equal(checkClose(), false);

  return { passed: 4, checks: ['multiple source buffers survive canceled unload', 'pending saves block unload until completion', 'failed saves preserve buffer and block unload', 'panel disposal protects its pending flush'] };
}

if (require.main === module) {
  verifyPaseoEditorClose(process.argv[2]).then(result => console.log(JSON.stringify(result)), error => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { verifyPaseoEditorClose };
