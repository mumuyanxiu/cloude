const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const pkg = require('../package.json');
const directory = path.resolve(__dirname, '..', pkg.build.directories.output.replace('${version}', pkg.version));
const installerName = pkg.build.nsis.artifactName.replace('${version}', pkg.version);
// Previously downloaded update scripts require this filename and its checksum.
const legacyInstallerName = `Cloud-Claude-Setup-${pkg.version}.exe`;
const names = [installerName, `${installerName}.blockmap`, 'latest.yml'];
for (const name of names) if (!fs.existsSync(path.join(directory, name))) throw new Error(`Missing release artifact: ${name}`);
fs.copyFileSync(path.join(directory, installerName), path.join(directory, legacyInstallerName));
names.push(legacyInstallerName);
names.sort();
const content = names.map(name => `${crypto.createHash('sha256').update(fs.readFileSync(path.join(directory, name))).digest('hex')}  ${name}`).join('\n') + '\n';
fs.writeFileSync(path.join(directory, 'SHA256SUMS.txt'), content);
console.log(`Generated checksums for ${names.length} release artifacts.`);
