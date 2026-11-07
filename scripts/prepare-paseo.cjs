const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const tar = require('tar');
const { patchPaseo } = require('./patch-paseo.cjs');

const root = path.resolve(__dirname, '..');
const lock = require('../paseo-lock.json');
const runtime = path.join(root, 'runtime', 'paseo');
const scratch = path.join(root, '.runtime');
const source = process.env.CLOUDE_PASEO_SOURCE || path.join(scratch, `paseo-${lock.commit}`);
const workspacePackages = ['protocol', 'relay', 'client', 'highlight', 'plugin', 'server', 'cli'];
const requiredRuntimeFiles = ['desktop-dist/main.js', 'desktop-dist/preload.js', 'app-dist/index.html', 'node_modules/@getpaseo/server/dist/scripts/supervisor-entrypoint.js'];

function buildFingerprint() {
  const hash = crypto.createHash('sha256');
  for (const file of ['paseo-lock.json', 'scripts/patch-paseo.cjs', 'scripts/patch-paseo-editor-close.cjs', 'scripts/patch-paseo-quit.cjs', 'scripts/paseo-cloude-quit.ts', 'scripts/verify-paseo-editor-close.cjs', 'scripts/verify-paseo-quit.cjs', 'scripts/prepare-paseo.cjs', 'scripts/paseo-runtime-package.json', 'scripts/paseo-runtime-lock.json', 'assets/claude-icon.png']) {
    hash.update(fs.readFileSync(path.join(root, file)));
  }
  hash.update(`${process.platform}-${process.arch}-${process.versions.node}-${require('../package.json').version}`);
  return hash.digest('hex');
}

async function hasPreparedRuntime(fingerprint) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(runtime, 'cloude-engine.json'), 'utf8'));
    if (manifest.inputsSha256 !== fingerprint) return false;
    const inventoryFile = path.join(runtime, 'runtime-files.json');
    if (await sha256(inventoryFile) !== manifest.inventorySha256) return false;
    const inventory = JSON.parse(await fsp.readFile(inventoryFile, 'utf8'));
    if (!requiredRuntimeFiles.every(file => Object.hasOwn(inventory, file))) return false;
    for (const [relative, expected] of Object.entries(inventory)) {
      const file = path.join(runtime, relative);
      assertRuntimeTarget(file);
      const stat = await fsp.stat(file);
      if (stat.size !== expected.size || await sha256(file) !== expected.sha256) return false;
    }
    return Object.keys(inventory).length > 100;
  } catch { return false; }
}

async function writeRuntimeInventory() {
  const inventory = {};
  async function visit(directory, relative = '') {
    for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
      const name = path.join(relative, entry.name);
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Runtime contains an unexpected symbolic link: ${name}`);
      if (entry.isDirectory()) await visit(file, name);
      else if (!name.endsWith('.map') && !['cloude-engine.json', 'runtime-files.json'].includes(name)) {
        inventory[name.replace(/\\/g, '/')] = { size: (await fsp.stat(file)).size, sha256: await sha256(file) };
      }
    }
  }
  await visit(runtime);
  const inventoryFile = path.join(runtime, 'runtime-files.json');
  await fsp.writeFile(inventoryFile, `${JSON.stringify(inventory, null, 2)}\n`);
  return sha256(inventoryFile);
}

function runNpm(args, cwd, environment = {}) {
  return new Promise((resolve, reject) => {
    // cmd is required to invoke npm.cmd on Windows. All arguments below are
    // fixed build commands, never shell text supplied by the renderer or user.
    const command = process.platform === 'win32' ? 'cmd.exe' : 'npm';
    const commandArgs = process.platform === 'win32' ? ['/d', '/s', '/c', 'npm', ...args] : args;
    const child = spawn(command, commandArgs, {
      cwd,
      env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=12288', ...environment },
      stdio: 'inherit',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`npm ${args.join(' ')} exited ${code}`)));
  });
}

async function sha256(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function assertRuntimeTarget(target) {
  const relative = path.relative(runtime, path.resolve(target));
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Runtime output escapes its directory');
}

async function copyDirectory(from, to, filter = () => true) {
  assertRuntimeTarget(to);
  await fsp.rm(to, { recursive: true, force: true });
  await fsp.cp(from, to, { recursive: true, dereference: true, filter });
}

async function getSource() {
  if (process.env.CLOUDE_PASEO_SOURCE && fs.existsSync(path.join(source, 'package.json'))) return;
  const sourceReceipt = path.join(source, '.cloude-source.json');
  try {
    const receipt = JSON.parse(await fsp.readFile(sourceReceipt, 'utf8'));
    if (receipt.commit === lock.commit && receipt.sha256 === lock.sha256 && fs.existsSync(path.join(source, 'package.json'))) return;
  } catch { /* A partial extraction must be completed before it can be reused. */ }
  await fsp.mkdir(scratch, { recursive: true });
  const archive = path.join(scratch, `paseo-${lock.commit}.tar.gz`);
  if (!fs.existsSync(archive)) {
    console.log(`Downloading Paseo ${lock.commit}`);
    const response = await fetch(lock.archive);
    if (!response.ok || !response.body) throw new Error(`Source download returned HTTP ${response.status}`);
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(`${archive}.partial`));
    await fsp.rename(`${archive}.partial`, archive);
  }
  if (await sha256(archive) !== lock.sha256) throw new Error('Paseo source archive checksum mismatch');
  await fsp.mkdir(source, { recursive: true });
  await tar.x({
    file: archive,
    cwd: source,
    strip: 1,
    strict: true,
    // Upstream documentation aliases are symlinks. Build inputs are regular
    // files, and excluding links also avoids Windows developer-mode requirements.
    filter: (_name, entry) => entry.type !== 'SymbolicLink' && entry.type !== 'Link',
  });
  await fsp.writeFile(sourceReceipt, JSON.stringify({ commit: lock.commit, sha256: lock.sha256 }));
}

async function installRuntimeDependencies() {
  const metadata = JSON.parse(await fsp.readFile(path.join(__dirname, 'paseo-runtime-package.json'), 'utf8'));
  await fsp.mkdir(runtime, { recursive: true });
  await fsp.writeFile(path.join(runtime, 'package.json'), `${JSON.stringify(metadata, null, 2)}\n`);
  await fsp.copyFile(path.join(__dirname, 'paseo-runtime-lock.json'), path.join(runtime, 'package-lock.json'));
  if (process.env.CLOUDE_PASEO_DEPENDENCIES) {
    await copyDirectory(path.join(process.env.CLOUDE_PASEO_DEPENDENCIES, 'node_modules'), path.join(runtime, 'node_modules'));
  } else if (process.env.CLOUDE_PASEO_SKIP_DEPENDENCIES !== '1') {
    await runNpm(['ci', '--omit=dev', '--no-audit', '--no-fund'], runtime);
  }
}

async function stageRuntime() {
  await installRuntimeDependencies();
  const keepBuiltFile = file => !/\.(map|tsbuildinfo)$/.test(file) && !/\.(test|spec)\.[cm]?[jt]sx?$/.test(file);
  await copyDirectory(path.join(source, 'packages', 'desktop', 'dist'), path.join(runtime, 'desktop-dist'), keepBuiltFile);
  await copyDirectory(path.join(source, 'packages', 'app', 'dist'), path.join(runtime, 'app-dist'));
  await copyDirectory(path.join(source, 'packages', 'desktop', 'assets'), path.join(runtime, 'assets'));
  await copyDirectory(path.join(source, 'packages', 'desktop', 'assets', 'editor-targets'), path.join(runtime, 'editor-target-icons'));
  await copyDirectory(path.join(source, 'packages', 'server', 'dist', 'server', 'builtin-plugins'), path.join(runtime, 'builtin-plugins'), keepBuiltFile);
  for (const name of workspacePackages) {
    const from = path.join(source, 'packages', name);
    const to = path.join(runtime, 'node_modules', '@getpaseo', name);
    await copyDirectory(path.join(from, 'dist'), path.join(to, 'dist'), keepBuiltFile);
    await fsp.copyFile(path.join(from, 'package.json'), path.join(to, 'package.json'));
    await fsp.copyFile(path.join(source, 'LICENSE'), path.join(to, 'LICENSE'));
  }
  // The desktop uses installed agent CLIs. Keep the same distribution policy as
  // upstream, which removes optional SDK copies of the Claude executable.
  const anthropic = path.join(runtime, 'node_modules', '@anthropic-ai');
  for (const name of await fsp.readdir(anthropic)) {
    if (name.startsWith('claude-agent-sdk-')) {
      const target = path.join(anthropic, name);
      assertRuntimeTarget(target);
      await fsp.rm(target, { recursive: true, force: true });
    }
  }
  await fsp.copyFile(path.join(source, 'LICENSE'), path.join(runtime, 'LICENSE'));
  await fsp.writeFile(path.join(runtime, 'engine-package.json'), `${JSON.stringify({ name: '@getpaseo/desktop', version: lock.version }, null, 2)}\n`);
  await fsp.copyFile(path.join(root, 'assets', 'claude-icon.png'), path.join(runtime, 'icon.png'));
  await fsp.copyFile(path.join(root, 'assets', 'claude-icon.png'), path.join(runtime, 'assets', 'icon.png'));
  await fsp.copyFile(path.join(root, 'assets', 'claude-icon.png'), path.join(runtime, 'assets', 'icon-dev.png'));
  await fsp.mkdir(path.join(runtime, 'bin'), { recursive: true });
  const shim = '@echo off\r\nsetlocal\r\nset "PASEO_HOME=%APPDATA%\\Cloud Claude\\paseo"\r\nif defined CLOUD_CLAUDE_DATA set "PASEO_HOME=%CLOUD_CLAUDE_DATA%\\paseo"\r\nif defined CLOUDE_DATA set "PASEO_HOME=%CLOUDE_DATA%\\paseo"\r\nset "ELECTRON_RUN_AS_NODE=1"\r\nset "PASEO_NODE_ENV=production"\r\n"%~dp0..\\..\\..\\Cloude.exe" --disable-warning=DEP0040 "%~dp0..\\desktop-dist\\daemon\\node-entrypoint-runner.js" node-script "%~dp0..\\node_modules\\@getpaseo\\cli\\dist\\index.js" %*\r\nexit /b %errorlevel%\r\n';
  await fsp.writeFile(path.join(runtime, 'bin', 'paseo.cmd'), shim);
  for (const file of requiredRuntimeFiles) {
    if (!fs.existsSync(path.join(runtime, file))) throw new Error(`Incomplete Paseo runtime: ${file}`);
  }
  const manifest = { ...lock, builtFor: `${process.platform}-${process.arch}`, nodeVersion: process.versions.node, inputsSha256: buildFingerprint(), inventorySha256: await writeRuntimeInventory() };
  await fsp.writeFile(path.join(runtime, 'cloude-engine.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Prepared Cloude Paseo runtime at ${runtime}`);
}

async function main() {
  const fingerprint = buildFingerprint();
  if (await hasPreparedRuntime(fingerprint)) {
    console.log(`Using verified build inputs for Paseo ${lock.version}`);
    return;
  }
  await getSource();
  const metadata = JSON.parse(await fsp.readFile(path.join(source, 'package.json'), 'utf8'));
  if (metadata.version !== lock.version) throw new Error('Paseo source version does not match paseo-lock.json');
  patchPaseo(source);
  await require('./verify-paseo-editor-close.cjs').verifyPaseoEditorClose(source);
  await require('./verify-paseo-quit.cjs').verifyPaseoQuit(source);
  if (process.env.CLOUDE_PASEO_SKIP_INSTALL !== '1') await runNpm(['ci', '--no-audit', '--no-fund'], source);
  if (process.env.CLOUDE_PASEO_SKIP_BUILD !== '1') {
    await runNpm(['run', 'build:server:clean'], source);
    await runNpm(['run', 'build', '--workspace=@getpaseo/expo-two-way-audio'], source);
    await runNpm(['exec', '--workspace=@getpaseo/app', '--', 'expo', 'export', '--platform', 'web'], source, { PASEO_WEB_PLATFORM: 'electron', CI: '1' });
    await runNpm(['run', 'build:main', '--workspace=@getpaseo/desktop'], source);
  }
  await stageRuntime();
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { main };
