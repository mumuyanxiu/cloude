'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const asar = require('@electron/asar');
const yaml = require('js-yaml');
const root = path.resolve(__dirname, '..');
const packageInfo = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
const version = packageInfo.version;
const releaseDirectory = path.join(root, packageInfo.build.directories.output.replace('${version}', version));
const archive = path.join(releaseDirectory, 'win-unpacked', 'resources', 'app.asar');
const verifiedFiles = [];
const verifiedRuntimeFiles = [];
function walk(directory) {
  for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
    if (entry.name === '__pycache__') continue; // Python test imports generate unshipped bytecode.
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(relative);
    else {
      assert.deepEqual(asar.extractFile(archive, relative), fs.readFileSync(path.join(root, relative)), `Packaged file differs: ${relative}`);
      verifiedFiles.push(relative);
    }
  }
}
for (const directory of ['electron', 'dist', 'assets']) walk(directory);

// The Paseo runtime stays outside ASAR because its daemon launches Node entrypoints
// and native modules from physical files. Verify the shipped tree against the
// prepared runtime instead of assuming extraResources copied every dependency.
if (packageInfo.main === 'electron/launcher.cjs') {
  assert.deepEqual(asar.extractFile(archive, 'THIRD-PARTY-NOTICES.md'), fs.readFileSync(path.join(root, 'THIRD-PARTY-NOTICES.md')));
  const runtimeSource = path.join(root, 'runtime', 'paseo');
  const runtimeDestination = path.join(releaseDirectory, 'win-unpacked', 'resources', 'paseo');
  function verifyRuntime(relative = '') {
    for (const entry of fs.readdirSync(path.join(runtimeSource, relative), { withFileTypes: true })) {
      if (entry.name.endsWith('.map')) continue; // extraResources omits source maps.
      const name = path.join(relative, entry.name);
      if (entry.name === '.gitkeep') {
        assert.equal(fs.statSync(path.join(runtimeSource, name)).size, 0, 'Only an empty builder-excluded placeholder may be omitted');
        continue;
      }
      assert.ok(!entry.isSymbolicLink(), 'Prepared runtime contains a symbolic link: ' + name);
      if (entry.isDirectory()) {
        verifyRuntime(name);
      } else {
        const expected = fs.readFileSync(path.join(runtimeSource, name));
        const actual = fs.readFileSync(path.join(runtimeDestination, name));
        assert.equal(crypto.createHash('sha256').update(actual).digest('hex'), crypto.createHash('sha256').update(expected).digest('hex'), 'Packaged runtime differs: ' + name);
        assert.ok(!/(?:^|[\\/])(?:workspace\.json|credentials\.json|known-hosts\.json|\.runtime)(?:[\\/]|$)/.test(name), 'User data entered Paseo runtime: ' + name);
        verifiedRuntimeFiles.push(name.replace(/\\/g, '/'));
      }
    }
  }
  verifyRuntime();
  const engine = JSON.parse(fs.readFileSync(path.join(runtimeDestination, 'cloude-engine.json'), 'utf8'));
  const engineLock = require('../paseo-lock.json');
  assert.equal(engine.commit, engineLock.commit);
  assert.equal(engine.version, engineLock.version);
  assert.equal(engine.sha256, engineLock.sha256);
  assert.equal(engine.builtFor, 'win32-x64');
  const inventory = fs.readFileSync(path.join(runtimeDestination, 'runtime-files.json'));
  assert.equal(crypto.createHash('sha256').update(inventory).digest('hex'), engine.inventorySha256);
  assert.equal(JSON.parse(fs.readFileSync(path.join(runtimeDestination, 'node_modules', '@getpaseo', 'server', 'package.json'), 'utf8')).version, engineLock.version);
  for (const relative of ['LICENSE', 'desktop-dist/main.js', 'desktop-dist/preload.js', 'app-dist/index.html', 'node_modules/@getpaseo/server/package.json', 'node_modules/@getpaseo/cli/package.json']) {
    assert.ok(fs.statSync(path.join(runtimeDestination, relative)).isFile(), 'Required Paseo runtime file missing: ' + relative);
  }
  assert.ok(verifiedRuntimeFiles.some(name => name.endsWith('node-entrypoint-runner.js')), 'Physical daemon runner missing');
  assert.ok(verifiedRuntimeFiles.some(name => /node-pty\/.*\.(node|exe)$/.test(name)), 'Windows PTY native runtime missing');
}

const packagedInfo = JSON.parse(asar.extractFile(archive, 'package.json'));
assert.equal(packagedInfo.version, version);
assert.equal(packagedInfo.main, packageInfo.main);
const installerName = packageInfo.build.nsis.artifactName.replace('${version}', version);
assert.equal(installerName, `Cloude-Setup-${version}.exe`);
assert.equal(packageInfo.name, 'cloude');
assert.equal(packageInfo.build.productName, 'Cloude');
assert.equal(packageInfo.build.appId, 'io.github.cloudclaude.desktop');
assert.ok(fs.statSync(path.join(releaseDirectory, 'win-unpacked', 'Cloude.exe')).isFile());
const executable = path.join(releaseDirectory, installerName);
const bytes = fs.readFileSync(executable);
const metadata = yaml.load(fs.readFileSync(path.join(releaseDirectory, 'latest.yml'), 'utf8'));
assert.equal(metadata.version, version);
assert.equal(metadata.path, path.basename(executable));
assert.equal(metadata.files[0].url, installerName);
assert.equal(metadata.sha512, crypto.createHash('sha512').update(bytes).digest('base64'));
assert.equal(metadata.files[0].size, bytes.length);
assert.equal(metadata.files[0].sha512, metadata.sha512);
const checksums = fs.readFileSync(path.join(releaseDirectory, 'SHA256SUMS.txt'), 'utf8').trim().split(/\r?\n/);
assert.equal(checksums.length, 3);
const expectedNames = [installerName, `${installerName}.blockmap`, 'latest.yml'].sort();
assert.deepEqual(checksums.map(line => line.slice(66)).sort(), expectedNames);
for (const line of checksums) {
  const match = /^([a-f0-9]{64})  ([A-Za-z0-9.-]+)$/.exec(line);
  assert.ok(match, 'Invalid checksum entry');
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(releaseDirectory, match[2]))).digest('hex'), match[1], `Checksum mismatch: ${match[2]}`);
}
const updateConfig = yaml.load(fs.readFileSync(path.join(releaseDirectory, 'win-unpacked', 'resources', 'app-update.yml'), 'utf8'));
assert.equal(updateConfig.provider, 'github');
assert.equal(updateConfig.owner, packageInfo.build.publish[0].owner);
assert.equal(updateConfig.repo, packageInfo.build.publish[0].repo);
assert.ok(asar.listPackage(archive).every(name => !/(?:^|[\\/])(?:workspace\.json|credentials\.json|known-hosts\.json|\.runtime)(?:[\\/]|$)/.test(name)), 'User data must not enter the archive');
const reportNames = process.argv.slice(2);
if (!reportNames.length) {
  reportNames.push('electron-smoke', 'renderer-flow', 'autoconnect-flow', 'usage-flow', 'commands-flow', 'models-flow', 'folder-upload-flow', 'credentials-crossprocess', 'updates-flow', 'features-flow', 'project-history-flow', 'workspace-restart-flow');
  if (packageInfo.main === 'electron/launcher.cjs') reportNames.push('paseo-flow', 'paseo-packaged-flow');
}
const integrationReports = reportNames.map(name => {
  assert.match(name, /^[a-z-]+$/, 'Invalid report name');
  const report = JSON.parse(fs.readFileSync(path.join(root, 'output', `${name}.json`)));
  assert.ok(report.passed > 0, `Missing test result: ${name}`);
  if (name === 'paseo-flow' || name === 'paseo-packaged-flow') {
    assert.equal(report.version, version, `Stale Paseo test result: ${name}`);
    assert.equal(report.actualDefaultEntry, true);
    assert.equal(report.actualBundledDaemon, true);
    assert.equal(report.actualNativePty, true);
  }
  if (name === 'paseo-packaged-flow') {
    assert.equal(path.resolve(report.packagedExecutable), path.join(releaseDirectory, 'win-unpacked', 'Cloude.exe'));
  }
  return { name, passed: report.passed };
});
const report = {
  version, verifiedAt: new Date().toISOString(), executable: path.relative(root, executable).replace(/\\/g, '/'),
  bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  verifiedFiles, verifiedRuntimeFiles, integrationReports, realDeviceTested: false,
};
fs.mkdirSync(path.join(root, 'output'), { recursive: true });
fs.writeFileSync(path.join(root, 'output', 'release-verification.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ version, filesVerified: verifiedFiles.length, runtimeFilesVerified: verifiedRuntimeFiles.length, bytes: report.bytes, sha256: report.sha256, integrationReports }, null, 2));
