'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { version: engineVersion } = require('../paseo-lock.json');

function verifyPaseoVersions(source) {
  const filename = path.join(source, 'packages/app/src/desktop/updates/desktop-updates.ts');
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    fileName: filename,
  });
  const dependencies = {
    '@/desktop/host': { isElectronRuntime: () => true },
    '@/desktop/electron/invoke': { invokeDesktopCommand: async () => null },
    '@/constants/platform': { isWeb: true },
    '@/i18n/i18next': { i18n: { t: value => value } },
  };
  const exports = {};
  vm.runInNewContext(compiled.outputText, {
    exports,
    require(name) {
      assert.ok(Object.hasOwn(dependencies, name), `Unexpected source dependency ${name}`);
      return dependencies[name];
    },
  }, { filename });
  assert.equal(exports.BUNDLED_ENGINE_VERSION, engineVersion);
  assert.equal(exports.isVersionMismatch('2.0.0', engineVersion), false);
  assert.equal(exports.isVersionMismatch('2.0.0', '0.0.1'), true);
  assert.equal(exports.isVersionMismatch('2.0.0', '2.0.0'), true);
  assert.equal(exports.isVersionMismatch('v2.0.0', ` v${engineVersion} `), false);
  assert.equal(exports.isVersionMismatch(null, engineVersion), false);
  assert.equal(exports.isVersionMismatch('', engineVersion), false);
  assert.equal(exports.isVersionMismatch('2.0.0', undefined), false);
  assert.equal(exports.formatVersionWithPrefix('2.0.0'), 'v2.0.0');
  assert.equal(exports.formatVersionWithPrefix(engineVersion), `v${engineVersion}`);

  const utilityFile = path.join(source, 'packages/app/src/utils/app-version.ts');
  const utility = ts.transpileModule(fs.readFileSync(utilityFile, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    fileName: utilityFile,
  });
  const utilityExports = {};
  const sourcePackage = JSON.parse(fs.readFileSync(path.join(source, 'packages/app/package.json'), 'utf8'));
  vm.runInNewContext(utility.outputText, {
    exports: utilityExports,
    require(name) {
      if (name === 'expo-constants') return { default: { expoConfig: {} } };
      assert.equal(name, '../../package.json');
      return { default: sourcePackage };
    },
  }, { filename: utilityFile });
  assert.equal(utilityExports.resolveAppVersion(), require('../package.json').version);
  assert.equal(utilityExports.resolvePaseoEngineVersion(), engineVersion);
  assert.equal(exports.isVersionMismatch(utilityExports.resolveAppVersion(), utilityExports.resolvePaseoEngineVersion()), false);
}

module.exports = { verifyPaseoVersions };
