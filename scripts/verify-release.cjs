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
function walk(directory) {
  for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(relative);
    else {
      assert.deepEqual(asar.extractFile(archive, relative), fs.readFileSync(path.join(root, relative)), `Packaged file differs: ${relative}`);
      verifiedFiles.push(relative);
    }
  }
}
for (const directory of ['electron', 'dist', 'assets']) walk(directory);
assert.equal(JSON.parse(asar.extractFile(archive, 'package.json')).version, version);
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
assert.equal(checksums.length, 4);
const expectedNames = [installerName, `${installerName}.blockmap`, `Cloud-Claude-Setup-${version}.exe`, 'latest.yml'].sort();
assert.deepEqual(checksums.map(line => line.slice(66)).sort(), expectedNames);
assert.ok(fs.readFileSync(path.join(releaseDirectory, `Cloud-Claude-Setup-${version}.exe`)).equals(bytes), 'Legacy installer alias must contain the same Cloude installer');
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
if (!reportNames.length) reportNames.push('electron-smoke', 'renderer-flow', 'autoconnect-flow', 'usage-flow', 'commands-flow', 'folder-upload-flow', 'credentials-crossprocess', 'updates-flow');
const integrationReports = reportNames.map(name => {
  assert.match(name, /^[a-z-]+$/, 'Invalid report name');
  const report = JSON.parse(fs.readFileSync(path.join(root, 'output', `${name}.json`)));
  assert.ok(report.passed > 0, `Missing test result: ${name}`);
  return { name, passed: report.passed };
});
const report = {
  version, verifiedAt: new Date().toISOString(), executable: path.relative(root, executable).replace(/\\/g, '/'),
  bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  verifiedFiles, integrationReports, realDeviceTested: false,
};
fs.mkdirSync(path.join(root, 'output'), { recursive: true });
fs.writeFileSync(path.join(root, 'output', 'release-verification.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ version, filesVerified: verifiedFiles.length, bytes: report.bytes, sha256: report.sha256, integrationReports }, null, 2));
